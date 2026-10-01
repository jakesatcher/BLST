const { Router } = require("express");
const db = require("../db");
const { requireRole, assertTournamentScope } = require("../middleware/auth");
const { badRequest, notFound, intParam, optEnum, optString, optBool } = require("../lib/http");
const { csvToObjects, normalizeHeader } = require("../lib/csv");
const reg = require("../services/registrations");
const leagueapps = require("../services/leagueapps");

const router = Router();
const admin = requireRole("admin");
const staff = requireRole("scorekeeper");

// Registrations hold personal data (emails, birth dates): admin only,
// except the check-in lookup, which scorekeepers at the rink can use.

router.get("/tournaments/:id/registrations", admin, async (req, res) => {
  const tid = intParam(req.params.id);
  const status = optEnum(req.query.status, "status", ["active", "waitlist", "cancelled"]);
  res.json(await reg.listRegistrations(tid, { status, review: req.query.review === "true" }));
});

/** Walk-up / manual registration. */
router.post("/tournaments/:id/registrations", admin, async (req, res) => {
  const tid = intParam(req.params.id);
  const r = await reg.registerOne(tid, {
    first_name: optString(req.body.first_name, "first_name", { max: 60 }),
    last_name: optString(req.body.last_name, "last_name", { max: 60 }),
    email: optString(req.body.email, "email", { max: 200 }),
    birth_date: optString(req.body.birth_date, "birth_date", { max: 20 }),
    position: optEnum(req.body.position, "position", ["C", "LW", "RW", "F", "D", "G"]),
  }, { source: "manual", status: optEnum(req.body.status, "status", ["active", "waitlist"]) || "active" });
  res.status(r.created ? 201 : 200).json({ ...r.registration, player: publicPlayer(r.player), history: r.history, match_method: r.registration.match_method });
});

const ALIASES = {
  first_name: ["first_name", "player_first_name", "participant_first_name", "first", "firstname"],
  last_name: ["last_name", "player_last_name", "participant_last_name", "last", "lastname", "surname"],
  name: ["name", "player", "player_name", "participant_name", "full_name"],
  email: ["email", "player_email", "participant_email", "email_address", "user_email"],
  birth_date: ["birth_date", "date_of_birth", "dob", "birthdate", "birthday", "player_birth_date"],
  user_id: ["user_id", "member_id", "leagueapps_user_id", "player_id_leagueapps"],
  status: ["registration_status", "status"],
  registered_at: ["registration_date", "registered", "date_registered", "created"],
  position: ["position", "pos"],
};
const pickAlias = (row, keys) => keys.map((k) => row[k]).find((v) => v !== undefined && v !== "");

/**
 * Registration import from a LeagueApps "Registrations Report" CSV (or any
 * sheet with name/email/birth date columns): the fallback when API keys
 * aren't set up yet. Same matching and codes as the API sync.
 */
router.post("/tournaments/:id/registrations/import", admin, async (req, res) => {
  const tid = intParam(req.params.id);
  const rows = Array.isArray(req.body.rows)
    ? req.body.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [normalizeHeader(k), v == null ? "" : String(v).trim()])))
    : typeof req.body.csv === "string" ? csvToObjects(req.body.csv) : null;
  if (!rows || !rows.length) throw badRequest("provide csv (text) or rows (array)");
  if (rows.length > 5000) throw badRequest("too many rows (max 5000)");
  const dryRun = optBool(req.body.dry_run, "dry_run") || false;
  const report = { rows: rows.length, created: 0, updated: 0, returning: 0, needs_review: 0, errors: [], preview: [], dry_run: dryRun };
  const client = await db.getPool().connect();
  try {
    await client.query("BEGIN");
    const t = (await client.query("SELECT * FROM tournaments WHERE id = $1 FOR UPDATE", [tid])).rows[0];
    if (!t) throw notFound("tournament");
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let first = pickAlias(row, ALIASES.first_name);
      let last = pickAlias(row, ALIASES.last_name);
      const full = pickAlias(row, ALIASES.name);
      if ((!first || !last) && full) {
        if (full.includes(",")) [last, first] = full.split(",").map((x) => x.trim());
        else [first, ...last] = full.split(/\s+/), (last = last.join(" "));
      }
      if (!first && !last) continue; // blank line
      await client.query("SAVEPOINT r");
      try {
        const status = /cancel|refund|withdr|inactive/i.test(pickAlias(row, ALIASES.status) || "") ? "cancelled" : /wait/i.test(pickAlias(row, ALIASES.status) || "") ? "waitlist" : "active";
        const r = await reg.upsertRegistration(client, t, {
          first_name: first, last_name: last, email: pickAlias(row, ALIASES.email), birth_date: pickAlias(row, ALIASES.birth_date),
          leagueapps_user_id: pickAlias(row, ALIASES.user_id), position: normalizePos(pickAlias(row, ALIASES.position)),
        }, { source: "csv", status });
        await client.query("RELEASE SAVEPOINT r");
        if (r.created) report.created += 1;
        else report.updated += 1;
        if (r.created && r.history.has_history) report.returning += 1;
        if (r.registration.needs_review) report.needs_review += 1;
        report.preview.push({ row: i + 2, code: r.registration.registration_code, name: `${r.player.first_name} ${r.player.last_name}`,
          player_code: r.player.player_code, match: r.registration.match_method, returning: r.history.has_history,
          prior_tournaments: r.history.prior_tournaments, needs_review: r.registration.needs_review, created: r.created });
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT r");
        report.errors.push({ row: i + 2, error: err.message });
      }
    }
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    report.committed = !dryRun;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json(report);
});

function normalizePos(v) {
  const s = String(v || "").trim().toUpperCase();
  return { G: "G", GOALIE: "G", D: "D", DEFENSE: "D", DEFENCE: "D", C: "C", CENTER: "C", LW: "LW", RW: "RW", F: "F", FORWARD: "F" }[s] || null;
}

function publicPlayer(p) {
  return p && { id: p.id, player_code: p.player_code, first_name: p.first_name, last_name: p.last_name };
}

/** Check-in: registration code or player code -> person, status and history. */
router.get("/registrations/lookup", staff, async (req, res) => {
  const result = await reg.lookup(req.query.code);
  if (result.registration) assertTournamentScope(req, result.registration.tournament_id);
  const isAdmin = req.auth.role === "admin";
  const p = result.player;
  res.json({
    ...result,
    player: isAdmin ? p : { ...publicPlayer(p), position: p.position },
  });
});

router.patch("/registrations/:id", admin, async (req, res) => {
  const id = intParam(req.params.id);
  const status = optEnum(req.body.status, "status", ["active", "waitlist", "cancelled"]);
  const reviewed = optBool(req.body.reviewed, "reviewed");
  const row = await db.one(
    `UPDATE tournament_registrations SET status = COALESCE($2, status),
            needs_review = CASE WHEN $3::boolean THEN FALSE ELSE needs_review END,
            review_note = COALESCE($4, review_note), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status ?? null, reviewed === true, optString(req.body.review_note, "review_note", { max: 300 }) ?? null],
  );
  if (!row) throw notFound("registration");
  res.json(row);
});

router.delete("/registrations/:id", admin, async (req, res) => {
  const r = await db.query("DELETE FROM tournament_registrations WHERE id = $1", [intParam(req.params.id)]);
  if (!r.rowCount) throw notFound("registration");
  res.status(204).end();
});

/** Duplicate cleanup: fold player `from_player_id` into this one. */
router.post("/players/:id/merge", admin, async (req, res) => {
  const keep = intParam(req.params.id);
  const from = intParam(req.body.from_player_id, "from_player_id");
  res.json(await reg.mergePlayers(keep, from));
});

router.get("/players/:id/registrations", admin, async (req, res) => {
  res.json(await db.many(
    `SELECT r.*, t.name AS tournament FROM tournament_registrations r JOIN tournaments t ON t.id = r.tournament_id
      WHERE r.player_id = $1 ORDER BY r.created_at`,
    [intParam(req.params.id)],
  ));
});

// ---------------------------------------------------------------------------
// LeagueApps

router.get("/integrations/leagueapps", admin, async (_req, res) => {
  res.json(await leagueapps.status());
});

router.post("/integrations/leagueapps/sync", admin, async (req, res) => {
  res.json(await leagueapps.sync({ fromScratch: optBool(req.body.from_scratch, "from_scratch") || false }));
});

/** Factions: every LeagueApps member with an email gets their Order. */
router.post("/integrations/leagueapps/members/sync", admin, async (req, res) => {
  res.json(await leagueapps.syncMembers({ fromScratch: optBool(req.body.from_scratch, "from_scratch") || false }));
});

router.get("/integrations/leagueapps/preview", admin, async (_req, res) => {
  res.json(await leagueapps.preview());
});

router.put("/integrations/leagueapps/field-map", admin, async (req, res) => {
  res.json({ override: await leagueapps.setFieldMap(req.body.map || req.body) });
});

/** Which LeagueApps program(s) feed this tournament's registrations. */
router.put("/tournaments/:id/leagueapps", admin, async (req, res) => {
  const tid = intParam(req.params.id);
  const ids = Array.isArray(req.body.program_ids) ? req.body.program_ids.map(String) : null;
  if (!ids || ids.some((x) => !/^\d{1,18}$/.test(x)) || ids.length > 50) throw badRequest("program_ids must be a list of LeagueApps program ids");
  const prefix = optString(req.body.registration_prefix, "registration_prefix", { max: 12 });
  if (prefix && !/^[A-Z0-9]{2,12}$/.test(prefix)) throw badRequest("registration prefix: 2-12 capital letters or digits");
  const row = await db.one(
    `UPDATE tournaments SET leagueapps_program_ids = $2::bigint[], registration_prefix = COALESCE($3, registration_prefix), updated_at = now()
      WHERE id = $1 RETURNING id, leagueapps_program_ids, registration_prefix`,
    [tid, ids, prefix ?? null],
  );
  if (!row) throw notFound("tournament");
  // Registrations already read past for unlinked programs must be read
  // again: restart the sync from the beginning (the sync is idempotent).
  await db.query("UPDATE sync_state SET last_updated = 0, last_id = 0 WHERE source = $1", [leagueapps.SOURCE]);
  res.json(row);
});

module.exports = router;
