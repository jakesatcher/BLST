const db = require("./index");

db.migrate()
  .then(() => db.close())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
