import sqlite3 from "sqlite3";

const db = new sqlite3.Database("./studysmarter.db");

db.serialize(() => {
  /* =========================
     USERS TABLE
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  /* =========================
     QUESTIONNAIRES TABLE
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS questionnaires (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      major TEXT,
      year TEXT,
      courses TEXT,
      study_hours TEXT,
      sleep_hours TEXT,
      study_times TEXT,
      available_days TEXT,
      gpa TEXT,
      goal TEXT,
      dates TEXT,
      study_methods TEXT,
      length TEXT,
      break_freq TEXT,
      challenging TEXT,
      study_challenges TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  /* =========================
     DEADLINES TABLE
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS deadlines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      due_date TEXT NOT NULL,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  /* =========================
     SETTINGS TABLE
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE,
      name TEXT,
      email TEXT,
      university TEXT,
      major TEXT,
      hours TEXT,
      break_length TEXT,
      notifications TEXT,
      intensity TEXT,
      theme TEXT,
      start_page TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  /* =========================
     AI STUDY PLANS TABLE
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS ai_study_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      questionnaire_id INTEGER,
      summary TEXT,
      weekly_plan TEXT,
      priority_subjects TEXT,
      study_tips TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (questionnaire_id) REFERENCES questionnaires(id)
    )
  `);

  /* =========================
     ACTIVE STUDY PLAN TABLE
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS active_study_plan (
      user_id INTEGER PRIMARY KEY,
      plan_id INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (plan_id) REFERENCES ai_study_plans(id)
    )
  `);

  /* =========================
     STUDY LOGS TABLE
  ========================= */
  db.run(`
    CREATE TABLE IF NOT EXISTS study_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      subject TEXT,
      hours REAL,
      focus INTEGER,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  /* =========================
     SAFE ALTERS FOR EXISTING DB
  ========================= */
  db.run(`ALTER TABLE questionnaires ADD COLUMN sleep_hours TEXT`, () => {});
  db.run(`ALTER TABLE settings ADD COLUMN theme TEXT`, () => {});
  db.run(`ALTER TABLE settings ADD COLUMN start_page TEXT`, () => {});
});

export default db;