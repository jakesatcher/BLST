const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { authenticate } = require("./middleware/auth");
const { HttpError, pgToHttp } = require("./lib/http");

function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { "default-src": ["'self'"], "script-src": ["'self'"], "style-src": ["'self'", "'unsafe-inline'"], "img-src": ["'self'", "data:"] },
      },
    }),
  );
  // Read APIs and the export API are meant to be called from other sites.
  app.use("/api", cors());
  app.use(express.json({ limit: "10mb" }));
  app.use(express.text({ type: ["text/csv", "text/plain"], limit: "10mb" }));
  // A raw CSV body is accepted anywhere JSON { csv } is.
  app.use((req, _res, next) => {
    if (typeof req.body === "string") req.body = { csv: req.body, ...req.query };
    if (req.body === undefined) req.body = {};
    next();
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const api = express.Router();
  api.use(authenticate);
  api.use(require("./routes/tournaments"));
  api.use(require("./routes/players"));
  api.use(require("./routes/games"));
  api.use(require("./routes/stream"));
  api.use(require("./routes/importExport"));
  api.use(require("./routes/admin"));
  api.use((_req, _res, next) => next(new HttpError(404, "not found")));
  app.use("/api/v1", api);

  app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === "entity.parse.failed") err = new HttpError(400, "request body is not valid JSON");
    if (err.type === "entity.too.large") err = new HttpError(413, "request body too large");
    const http = pgToHttp(err);
    if (http) return res.status(http.status).json({ error: http.message, ...(http.details ? { details: http.details } : {}) });
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  });
  return app;
}

module.exports = { createApp };
