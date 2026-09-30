require("dotenv").config({ quiet: true });

const bool = (v, dflt) => (v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v));

// DYNO is set on every Heroku dyno — same "are we deployed" signal the
// BLPA Factions app uses.
const deployed = Boolean(process.env.DYNO) || process.env.NODE_ENV === "production";

module.exports = {
  port: Number(process.env.PORT || 3000),
  deployed,
  databaseUrl: process.env.DATABASE_URL || "postgresql://blst:blst@localhost:5432/blst",
  databaseSsl: bool(process.env.DATABASE_SSL, Boolean(process.env.DYNO)),
  adminToken: process.env.ADMIN_TOKEN || "",
  publicExports: bool(process.env.PUBLIC_EXPORTS, true),
  factions: {
    baseUrl: (process.env.FACTIONS_BASE_URL || "").replace(/\/+$/, ""),
    adminToken: process.env.FACTIONS_ADMIN_TOKEN || "",
    autoSync: bool(process.env.FACTIONS_AUTO_SYNC, false),
  },
};
