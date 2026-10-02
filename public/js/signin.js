/* Sign-in: an emailed code for everyone, then (for accounts that have one)
   an authenticator code, a passkey or a backup code. Admins and scorekeepers
   are asked to set up an authenticator app or passkey.
   Used by the Account, Admin, Scorekeeper and platform pages:
   BLST.signInFlow(container, { mode, onDone }) and BLST.mfaSetup(container, { onDone }). */
(function () {
  const { h, mount, api, setToken, toast } = window.BLST;

  const MODES = {
    login: { title: "Sign in", button: "Email me a code", fields: ["email"] },
    signup: { title: "Create an account", button: "Create account", fields: ["email"] },
    setup: { title: "Set up the admin account", button: "Start setup", fields: ["setup_key", "email"] },
  };
  const ENDPOINT = { login: "/auth/login", signup: "/auth/signup", setup: "/auth/setup" };

  function fieldEl(name) {
    if (name === "email") {
      return h("label", null, "Email", h("input", { name, type: "email", required: true, autocomplete: "email webauthn", inputmode: "email", placeholder: "you@example.com", maxlength: 254 }));
    }
    return h("label", null, "Setup key",
      h("input", { name, type: "password", required: true, autocomplete: "off", placeholder: "From the server log, or ADMIN_TOKEN" }),
      h("span", { class: "small muted" }, "Railway: the service's Deploy Logs (\"setup key\"), or ADMIN_TOKEN in Variables. It works only until the first admin account exists."));
  }

  function errorBox() {
    const err = h("div", { class: "notice error hidden", role: "alert" });
    const show = (e) => {
      err.textContent = e ? e.message || String(e) : "";
      err.classList.toggle("hidden", !e);
    };
    return [err, show];
  }

  // -------------------------------------------------------------------------
  // WebAuthn (passkeys): JSON <-> browser credential objects

  const fromB64u = (s) => {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
    return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
  };
  const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const passkeysSupported = () => typeof window.PublicKeyCredential === "function" && navigator.credentials;

  async function createPasskey(o) {
    const publicKey = {
      ...o, challenge: fromB64u(o.challenge), user: { ...o.user, id: fromB64u(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })),
    };
    const cred = await navigator.credentials.create({ publicKey });
    const r = cred.response;
    return {
      id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject),
        transports: r.getTransports ? r.getTransports() : [],
      },
    };
  }
  async function getPasskey(o) {
    const publicKey = { ...o, challenge: fromB64u(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })) };
    const cred = await navigator.credentials.get({ publicKey });
    const r = cred.response;
    return {
      id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature),
        userHandle: r.userHandle ? toB64u(r.userHandle) : undefined,
      },
    };
  }
  /** Plain-language reasons for WebAuthn failures (the browser's own text is vague). */
  function passkeyError(e) {
    const name = e && e.name;
    if (name === "NotAllowedError") return new Error("No passkey was used. The prompt was closed, timed out, or this device has no passkey for this account. Try again, or use \"Use a phone or other device\" in the prompt.");
    if (name === "InvalidStateError") return new Error("This device already has a passkey for your account.");
    if (name === "SecurityError") return new Error("Passkeys can't be used on this address. Open the site at its normal https:// address and try again.");
    if (name === "NotSupportedError") return new Error("This browser or device doesn't support passkeys. Use an authenticator app instead.");
    if (name === "AbortError") return new Error("The passkey prompt was interrupted. Try again.");
    return e;
  }

  /**
   * Fetches WebAuthn options ahead of the tap, so the browser prompt opens
   * straight from the tap (Safari and iOS refuse prompts that start after a
   * network wait). Options are refreshed if they're older than 4 minutes.
   */
  function prefetched(load) {
    let p = null;
    let at = 0;
    const fresh = () => {
      if (!p || Date.now() - at > 4 * 60e3) {
        at = Date.now();
        p = load();
        p.catch(() => { p = null; });
      }
      return p;
    };
    return { warm: () => { fresh().catch(() => {}); }, take: () => { const x = fresh(); p = null; return x; } };
  }

  // -------------------------------------------------------------------------
  // Sign in / sign up / admin setup

  /**
   * Renders the flow into `box`: details → emailed code → (second factor).
   * onDone(result) gets { token, account, mfa_setup_required }. Staff without
   * a second factor are taken through setting one up first.
   */
  function signInFlow(box, { mode = "login", onDone, intro } = {}) {
    const m = MODES[mode];
    const [err, showErr] = errorBox();

    const finish = (r) => {
      if (r.token) setToken(r.token);
      if (r.mfa_setup_required) {
        return mfaSetup(box, { required: true, onDone: () => onDone({ ...r, mfa_setup_required: false }) });
      }
      onDone(r);
    };

    function details() {
      const form = h("form", { class: "stack signin", onsubmit: async (e) => {
        e.preventDefault();
        showErr(null);
        const body = Object.fromEntries([...form.elements].filter((el) => el.name).map((el) => [el.name, el.value.trim()]));
        busy(form, true);
        try {
          emailStep(await api("POST", ENDPOINT[mode], body));
        } catch (e2) {
          showErr(e2);
          busy(form, false);
        }
      } },
      m.fields.map(fieldEl),
      err,
      h("button", { class: "primary big-button" }, m.button));
      mount(box, intro ? h("p", { class: "muted" }, intro) : "", form);
      const first = form.querySelector("input");
      if (first) first.focus();
    }

    function emailStep(state) {
      const input = h("input", {
        name: "code", class: "code-input", required: true, autocomplete: "one-time-code", inputmode: "numeric",
        pattern: "\\d{6}", maxlength: 6, placeholder: "••••••", "aria-label": "6-digit code",
      });
      const resend = h("button", { type: "button", class: "link", onclick: async () => {
        showErr(null);
        try {
          await api("POST", "/auth/resend", { challenge_id: state.challenge_id });
          toast("New code sent");
        } catch (e) {
          showErr(e);
        }
      } }, "Send a new code");
      const form = h("form", { class: "stack signin", onsubmit: async (e) => {
        e.preventDefault();
        showErr(null);
        busy(form, true);
        try {
          const r = await api("POST", "/auth/verify", { challenge_id: state.challenge_id, code: input.value.trim() });
          if (r.step === "mfa") return mfaStep(r);
          finish(r);
        } catch (e2) {
          showErr(e2);
          busy(form, false);
          input.select();
          if (e2.status === 410) setTimeout(details, 1800);
        }
      } },
      h("p", null, "Enter the code we emailed to ", h("strong", null, state.sent_to), "."),
      h("label", null, "Code from the email", input),
      err,
      h("button", { class: "primary big-button" }, "Continue"),
      h("div", { class: "row between small" }, resend, h("button", { type: "button", class: "link", onclick: details }, "Start over")));
      mount(box, form);
      input.focus();
    }

    function mfaStep(state, { backup = false } = {}) {
      const methods = state.methods || {};
      const pk = prefetched(() => api("POST", "/auth/passkey-options", { challenge_id: state.challenge_id }));
      if (methods.passkey && passkeysSupported()) pk.warm();
      const usePasskey = async () => {
        showErr(null);
        try {
          const passkey = await getPasskey(await pk.take());
          finish(await api("POST", "/auth/verify", { challenge_id: state.challenge_id, passkey }));
        } catch (e) {
          showErr(passkeyError(e));
          if (e && e.status === 410) setTimeout(details, 1800);
        }
      };
      const input = backup
        ? h("input", { name: "code", class: "code-input", required: true, autocomplete: "off", autocapitalize: "none", maxlength: 12, placeholder: "xxxx-xxxx", "aria-label": "Backup code" })
        : h("input", { name: "code", class: "code-input", required: true, autocomplete: "one-time-code", inputmode: "numeric", pattern: "\\d{6}", maxlength: 6, placeholder: "••••••", "aria-label": "Authenticator code" });
      const form = h("form", { class: "stack signin", onsubmit: async (e) => {
        e.preventDefault();
        showErr(null);
        busy(form, true);
        try {
          finish(await api("POST", "/auth/verify", { challenge_id: state.challenge_id, code: input.value.trim() }));
        } catch (e2) {
          showErr(e2);
          busy(form, false);
          input.select();
          if (e2.status === 410) setTimeout(details, 1800);
        }
      } },
      h("p", null, backup ? "Enter one of your backup codes. Each one works once." : "Now confirm it's you."),
      methods.passkey && passkeysSupported() && !backup ? h("button", { type: "button", class: "primary big-button", onclick: usePasskey }, "Use a passkey") : "",
      methods.totp || backup ? [h("label", null, backup ? "Backup code" : "Code from your authenticator app", input),
        h("button", { class: methods.passkey && !backup ? "big-button" : "primary big-button" }, "Sign in")] : "",
      err,
      h("div", { class: "row between small" },
        methods.backup_code ? h("button", { type: "button", class: "link", onclick: () => mfaStep(state, { backup: !backup }) },
          backup ? "Use the app or a passkey instead" : "Use a backup code") : h("span"),
        h("button", { type: "button", class: "link", onclick: details }, "Start over")));
      mount(box, form);
      if (methods.totp || backup) input.focus();
    }

    details();
  }

  // -------------------------------------------------------------------------
  // Setting up a second factor (staff, or anyone who wants one)

  /** Shows backup codes once, with a "saved them" button. */
  function showBackupCodes(box, codes, onDone) {
    const text = codes.join("\n");
    mount(box, h("div", { class: "stack signin" },
      h("h2", null, "Save your backup codes"),
      h("p", null, "If you lose your phone, each of these codes signs you in once. Keep them somewhere safe, like a password manager. They won't be shown again."),
      h("pre", { class: "backup-codes" }, text),
      h("div", { class: "row" },
        h("button", { type: "button", onclick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast("Copied");
          } catch {
            toast("Select the codes and copy them", true);
          }
        } }, "Copy"),
        h("button", { type: "button", onclick: () => {
          const a = h("a", { href: URL.createObjectURL(new Blob([`Beer League Stats backup codes\n\n${text}\n`], { type: "text/plain" })), download: "beer-league-stats-backup-codes.txt" });
          a.click();
        } }, "Download")),
      h("button", { type: "button", class: "primary big-button", onclick: onDone }, "I've saved them")));
  }

  /**
   * Set up an authenticator app or a passkey. `required` explains that staff
   * access needs it. onDone() runs when it's set up (after backup codes).
   */
  function mfaSetup(box, { required = false, onDone, onCancel } = {}) {
    const [err, showErr] = errorBox();
    const done = (r) => (r && r.backup_codes ? showBackupCodes(box, r.backup_codes, onDone) : onDone());

    const reg = prefetched(() => api("POST", "/account/mfa/passkeys/options"));
    function choose() {
      if (passkeysSupported()) reg.warm();
      mount(box, h("div", { class: "stack signin" },
        h("h2", null, "Add a second step to sign-in"),
        required ? h("p", null, "Your account can run games or change settings, so it needs more than an emailed code. Set up one of these to continue:") : h("p", null, "Choose how you'll confirm it's you after the emailed code:"),
        passkeysSupported() ? h("button", { type: "button", class: "primary big-button", onclick: passkey }, "Use a passkey (Face ID, fingerprint or PIN)") : "",
        h("button", { type: "button", class: passkeysSupported() ? "big-button" : "primary big-button", onclick: totp }, "Use an authenticator app"),
        h("p", { class: "small muted" }, "A passkey is saved on this phone or computer (and synced by Apple, Google or your password manager). An authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) shows a new 6-digit code every 30 seconds."),
        err,
        onCancel ? h("button", { type: "button", class: "link", onclick: onCancel }, required ? "Not now" : "Cancel") : ""));
    }

    async function passkey() {
      showErr(null);
      try {
        const response = await createPasskey(await reg.take());
        const name = /iPhone|iPad|Mac/.test(navigator.userAgent) ? "Apple device" : /Android/.test(navigator.userAgent) ? "Android phone" : /Windows/.test(navigator.userAgent) ? "Windows computer" : "Passkey";
        const r = await api("POST", "/account/mfa/passkeys", { response, name });
        toast("Passkey added");
        done(r);
      } catch (e) {
        showErr(passkeyError(e));
        reg.warm(); // a fresh challenge for the next try
      }
    }

    async function totp() {
      showErr(null);
      let s;
      try {
        s = await api("POST", "/account/mfa/totp");
      } catch (e) {
        return showErr(e);
      }
      const input = h("input", { class: "code-input", required: true, autocomplete: "one-time-code", inputmode: "numeric", pattern: "\\d{6}", maxlength: 6, placeholder: "••••••", "aria-label": "6-digit code" });
      const form = h("form", { class: "stack signin", onsubmit: async (e) => {
        e.preventDefault();
        showErr(null);
        busy(form, true);
        try {
          const r = await api("POST", "/account/mfa/totp/confirm", { code: input.value.trim() });
          toast("Authenticator app set up");
          done(r);
        } catch (e2) {
          showErr(e2);
          busy(form, false);
          input.select();
        }
      } },
      h("h2", null, "Set up your authenticator app"),
      h("ol", { class: "small" },
        h("li", null, "Open your authenticator app and add an account (often a + button)."),
        h("li", null, "Scan this code. On this phone? Tap ", h("a", { href: s.uri }, "open in authenticator app"), " or enter the key below."),
        h("li", null, "Type the 6-digit code the app shows.")),
      h("img", { class: "totp-qr", src: s.qr, alt: "QR code for your authenticator app", width: 200, height: 200 }),
      h("p", { class: "small" }, "Key: ", h("code", { class: "mono" }, s.secret)),
      h("label", null, "Code from the app", input),
      err,
      h("button", { class: "primary big-button" }, "Turn on"),
      h("button", { type: "button", class: "link", onclick: choose }, "Back"));
      mount(box, form);
      input.focus();
    }

    choose();
  }

  function busy(form, on) {
    for (const el of form.querySelectorAll("button, input")) el.disabled = on;
  }

  async function signOut() {
    await api("POST", "/auth/logout").catch(() => {});
    setToken("");
  }

  Object.assign(window.BLST, { signInFlow, signOut, mfaSetup, showBackupCodes, passkeysSupported, createPasskey });
})();
