/* Email + SMS sign-in (MFA for every account). Used by the Account, Admin
   and Scorekeeper pages: BLST.signInFlow(container, { mode, onDone }). */
(function () {
  const { h, mount, api, setToken, toast } = window.BLST;

  const MODES = {
    login: { title: "Sign in", button: "Email me a code", fields: ["email"] },
    signup: { title: "Create an account", button: "Create account", fields: ["email", "phone"] },
    setup: { title: "Set up the admin account", button: "Start setup", fields: ["setup_key", "email", "phone"] },
    phone: { title: "Change mobile number", button: "Send codes", fields: ["phone"] },
  };
  const ENDPOINT = { login: "/auth/login", signup: "/auth/signup", setup: "/auth/setup", phone: "/account/phone" };

  function fieldEl(name) {
    if (name === "email") {
      return h("label", null, "Email", h("input", { name, type: "email", required: true, autocomplete: "email", inputmode: "email", placeholder: "you@example.com", maxlength: 254 }));
    }
    if (name === "phone") {
      return h("label", null, "Mobile number (for text-message codes)",
        h("input", { name, type: "tel", required: true, autocomplete: "tel", inputmode: "tel", placeholder: "(555) 123-4567", maxlength: 24 }),
        h("span", { class: "small muted" }, "Message and data rates may apply. We only use it to text you sign-in codes."));
    }
    return h("label", null, "Setup key",
      h("input", { name, type: "password", required: true, autocomplete: "off", placeholder: "The server's ADMIN_TOKEN" }),
      h("span", { class: "small muted" }, "On Heroku: Settings → Reveal Config Vars → ADMIN_TOKEN. It works only until the first admin account exists."));
  }

  /**
   * Renders the flow into `box`. Steps: details → emailed code → texted code.
   * onDone(result) gets { token, account } (or { phone_changed } for "phone").
   */
  function signInFlow(box, { mode = "login", onDone, intro } = {}) {
    const m = MODES[mode];
    const err = h("div", { class: "notice error hidden", role: "alert" });
    const showErr = (e) => {
      err.textContent = e ? e.message || String(e) : "";
      err.classList.toggle("hidden", !e);
    };

    function details() {
      const form = h("form", { class: "stack signin", onsubmit: async (e) => {
        e.preventDefault();
        showErr(null);
        const body = Object.fromEntries([...form.elements].filter((el) => el.name).map((el) => [el.name, el.value.trim()]));
        busy(form, true);
        try {
          const r = await api("POST", ENDPOINT[mode], body);
          codeStep(r, body.email);
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

    function codeStep(state) {
      const isSms = state.step === "sms";
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
          if (r.step === "sms") return codeStep(r);
          if (r.token) setToken(r.token);
          onDone(r);
        } catch (e2) {
          showErr(e2);
          busy(form, false);
          input.select();
          if (e2.status === 410) setTimeout(details, 1800);
        }
      } },
      h("div", { class: "steps-mini" },
        h("span", { class: isSms ? "done" : "now" }, "1 Email"), h("span", { class: isSms ? "now" : null }, "2 Text message")),
      h("p", null, isSms ? "Now enter the code we texted to " : "Enter the code we emailed to ", h("strong", null, state.sent_to), "."),
      h("label", null, isSms ? "Code from the text message" : "Code from the email", input),
      err,
      h("button", { class: "primary big-button" }, isSms ? "Verify and continue" : "Next"),
      h("div", { class: "row between small" }, resend, h("button", { type: "button", class: "link", onclick: details }, "Start over")));
      mount(box, form);
      input.focus();
      // Android Chrome can read the texted code straight into the box (WebOTP).
      if (isSms && "OTPCredential" in window) {
        const ac = new AbortController();
        form.addEventListener("submit", () => ac.abort(), { once: true });
        navigator.credentials.get({ otp: { transport: ["sms"] }, signal: ac.signal })
          .then((otp) => { if (otp && otp.code) { input.value = otp.code; form.requestSubmit(); } })
          .catch(() => {});
      }
    }

    details();
  }

  function busy(form, on) {
    for (const el of form.querySelectorAll("button, input")) el.disabled = on;
  }

  async function signOut() {
    await api("POST", "/auth/logout").catch(() => {});
    setToken("");
  }

  Object.assign(window.BLST, { signInFlow, signOut });
})();
