// Database tables. The site creates and upgrades them itself on first use,
// so nobody has to run database commands by hand.

const MIGRATIONS = [
  // 1: receipts and their files
  [
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
    // status: draft (needs details), open (not reimbursed yet),
    //         reimbursed (paid back from the HSA), hsa_paid (paid with the HSA card)
    `CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'draft',
      service_date TEXT,
      provider TEXT,
      patient TEXT,
      category TEXT,
      amount REAL,
      paid_date TEXT,
      paid_with TEXT,
      reimbursed_date TEXT,
      reimbursed_amount REAL,
      notes TEXT,
      ocr_text TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS expenses_status ON expenses(status, service_date)`,
    `CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INTEGER NOT NULL,
      r2_key TEXT NOT NULL,
      name TEXT,
      type TEXT,
      size INTEGER,
      kind TEXT DEFAULT 'receipt',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS files_expense ON files(expense_id)`,
  ],
  // 2: separate HSA accounts (one per spouse)
  [
    `ALTER TABLE expenses ADD COLUMN account TEXT`,
    `UPDATE expenses SET account = '1' WHERE account IS NULL`,
    `CREATE INDEX IF NOT EXISTS expenses_account ON expenses(account, status)`,
  ],
];

let ready = false;

export async function ensureSchema(db) {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).first();
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    const stmts = MIGRATIONS[version].map((sql) => db.prepare(sql));
    version += 1;
    stmts.push(
      db.prepare(`INSERT INTO settings (key, value) VALUES ('schema_version', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(version)),
    );
    await db.batch(stmts);
  }
  ready = true;
}
