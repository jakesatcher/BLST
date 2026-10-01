const { EventEmitter } = require("events");

// In-process pub/sub. "game" messages drive SSE pushes to viewers;
// "domain" messages are the public event stream forwarded to webhooks
// and the Factions auto-sync. Single-process by design: run one web dyno,
// or swap this for Postgres LISTEN/NOTIFY before scaling out.
const { currentOrg } = require("./context");

const bus = new EventEmitter();
bus.setMaxListeners(0);

function emitDomain(event, data) {
  // Listeners run in the emitter's context (same org); orgId lets the
  // live stream send each event only to that organization's viewers.
  bus.emit("domain", { event, data, orgId: currentOrg(), created_at: new Date().toISOString() });
}

module.exports = { bus, emitDomain };
