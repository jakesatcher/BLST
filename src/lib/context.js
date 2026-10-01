const { AsyncLocalStorage } = require("async_hooks");

// Which organization the current request (or background job) is acting for.
// Every database query sets it on its connection (app.org_id), and Postgres
// row-level security then only shows and accepts that organization's rows.
//   number  one organization
//   "*"     every organization (platform jobs and the global admin's tools)
//   ""      none: tenant tables look empty and inserts fail (the default)
const als = new AsyncLocalStorage();
let fallback = "";

function currentOrg() {
  const s = als.getStore();
  return s ? s.org : fallback;
}

/** Runs fn (and everything it starts: awaits, timers, events) as `org`. */
function withOrg(org, fn) {
  if (!(org === "*" || org === "" || Number.isInteger(org))) throw new Error(`invalid org context: ${org}`);
  return als.run({ org }, fn);
}

/** Context outside any request: scripts and tests. Requests never use it. */
function setFallbackOrg(org) {
  fallback = org;
}

module.exports = { currentOrg, withOrg, setFallbackOrg };
