import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "./database.js";

const app = express();
const PORT = 3000;
const SECRET = "studysmarter_secret_key";

app.use(cors());
app.use(express.json());

/* =========================
   TEST ROUTE
========================= */
app.get("/", (req, res) => {
  res.json({ message: "Backend running" });
});

/* =========================
   AUTH MIDDLEWARE
========================= */
function auth(req, res, next) {
  const header = req.headers["authorization"];
  const token = header && header.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "No token" });
  }

  jwt.verify(token, SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: "Invalid token" });
    }

    req.user = user;
    next();
  });
}

/* =========================
   OPENAI HELPERS
========================= */
async function callOpenAI(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY environment variable.");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "OpenAI request failed.");
  }

  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("No content returned from OpenAI.");
  }

  return content;
}

async function getUserDeadlines(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT * FROM deadlines
      WHERE user_id = ?
      ORDER BY due_date ASC, id ASC
      `,
      [userId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

async function generateAIStudyPlan(questionnaire, deadlines) {
  const prompt = `
You are an academic planning assistant for a study-planning app.

Generate a structured JSON object for a personalized weekly study plan.

The JSON must follow this exact shape:
{
  "summary": "string",
  "weekly_plan": [
    {
      "day": "string",
      "time": "string",
      "focus": "string",
      "task": "string"
    }
  ],
  "priority_subjects": ["string"],
  "study_tips": ["string"]
}

Rules:
- Return valid JSON only.
- No markdown.
- No code fences.
- Weekly plan should include 4 to 7 study sessions.
- Make the schedule realistic based on available days and preferred study times.
- Give extra priority to difficult subjects and upcoming dates.
- Use upcoming deadlines heavily when deciding priorities.
- Consider the student sleep schedule and avoid unrealistic study hours.
- Keep tips practical and student-friendly.

Student questionnaire:
Major: ${questionnaire.major || ""}
Year: ${questionnaire.year || ""}
Courses: ${questionnaire.courses || ""}
Study hours per week: ${questionnaire.study_hours || ""}
Sleep hours per night: ${questionnaire.sleep_hours || ""}
Preferred study times: ${questionnaire.study_times || ""}
Available days: ${(questionnaire.available_days || []).join(", ")}
Target GPA: ${questionnaire.gpa || ""}
Primary goal: ${questionnaire.goal || ""}
Upcoming important dates text: ${questionnaire.dates || ""}
Preferred study methods: ${(questionnaire.study_methods || []).join(", ")}
Study session length: ${questionnaire.length || ""}
Break frequency: ${questionnaire.breakFreq || ""}
Challenging subjects: ${questionnaire.challenging || ""}
Study challenges: ${(questionnaire.study_challenges || []).join(", ")}

Structured deadlines:
${deadlines.length ? deadlines.map((d, index) => `${index + 1}. ${d.type}: ${d.title} on ${d.due_date}${d.note ? ` (${d.note})` : ""}`).join("\n") : "No structured deadlines."}
  `.trim();

  const content = await callOpenAI(
    "You generate structured academic study plans as valid JSON.",
    prompt
  );

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OpenAI returned invalid JSON.");
  }

  return parsed;
}

async function generateProgressInsights({ questionnaire, logs }) {
  const prompt = `
You are an academic performance insight assistant for a study-planning app.

Generate a JSON object with progress insights based on the student's weekly target and real study logs.

The JSON must follow this exact shape:
{
  "summary": "string",
  "status": "On Track",
  "insights": ["string"],
  "recommendations": ["string"],
  "next_action": "string"
}

Rules:
- Return valid JSON only.
- No markdown.
- No code fences.
- Keep the tone supportive, practical, and concise.
- Use the logs to identify patterns in hours, focus, and subjects.
- Compare real logged hours against the target weekly hours.
- Mention if the student is behind, on track, or ahead.
- Recommendations should be practical and specific.

Student questionnaire:
Study hours per week: ${questionnaire.study_hours || ""}
Sleep hours per night: ${questionnaire.sleep_hours || ""}
Primary goal: ${questionnaire.goal || ""}
Courses: ${questionnaire.courses || ""}
Challenging subjects: ${questionnaire.challenging || ""}
Preferred study methods: ${(questionnaire.study_methods || []).join(", ")}
Upcoming dates: ${questionnaire.dates || ""}

Study logs:
${logs.length ? logs.map((log, index) => {
    return `${index + 1}. Subject: ${log.subject}, Hours: ${log.hours}, Focus: ${log.focus}, Notes: ${log.notes || ""}, Created: ${log.created_at}`;
  }).join("\n") : "No logs yet."}
  `.trim();

  const content = await callOpenAI(
    "You analyze student progress and return valid JSON insights only.",
    prompt
  );

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OpenAI returned invalid JSON for progress insights.");
  }

  return parsed;
}

/* =========================
   STUDY PLAN HELPERS
========================= */
function setActivePlan(userId, planId, callback) {
  db.run(
    `
    INSERT INTO active_study_plan (user_id, plan_id, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id)
    DO UPDATE SET plan_id = excluded.plan_id, updated_at = CURRENT_TIMESTAMP
    `,
    [userId, planId],
    callback
  );
}

function getLatestPlanId(userId, callback) {
  db.get(
    `
    SELECT id
    FROM ai_study_plans
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [userId],
    callback
  );
}

/* =========================
   REGISTER
========================= */
app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required" });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);

    db.run(
      "INSERT INTO users (username, password) VALUES (?, ?)",
      [username, hashed],
      function (err) {
        if (err) {
          return res.status(400).json({ message: "User already exists" });
        }

        const token = jwt.sign(
          { id: this.lastID, username },
          SECRET,
          { expiresIn: "1d" }
        );

        res.json({
          message: "User registered",
          token,
          user: { id: this.lastID, username }
        });
      }
    );
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

/* =========================
   LOGIN
========================= */
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required" });
  }

  db.get(
    "SELECT * FROM users WHERE username = ?",
    [username],
    async (err, user) => {
      if (err) {
        return res.status(500).json({ message: "Database error" });
      }

      if (!user) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      const valid = await bcrypt.compare(password, user.password);

      if (!valid) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      const token = jwt.sign(
        { id: user.id, username: user.username },
        SECRET,
        { expiresIn: "1d" }
      );

      res.json({
        message: "Login successful",
        token,
        user: { id: user.id, username: user.username }
      });
    }
  );
});

/* =========================
   SAVE QUESTIONNAIRE
========================= */
app.post("/questionnaire", auth, (req, res) => {
  const data = req.body;

  db.run(
    `
    INSERT INTO questionnaires (
      user_id, major, year, courses, study_hours, sleep_hours, study_times,
      available_days, gpa, goal, dates, study_methods,
      length, break_freq, challenging, study_challenges
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      req.user.id,
      data.major || "",
      data.year || "",
      data.courses || "",
      data.study_hours || "",
      data.sleep_hours || "",
      data.study_times || "",
      JSON.stringify(data.available_days || []),
      data.gpa || "",
      data.goal || "",
      data.dates || "",
      JSON.stringify(data.study_methods || []),
      data.length || "",
      data.breakFreq || "",
      data.challenging || "",
      JSON.stringify(data.study_challenges || [])
    ],
    function (err) {
      if (err) {
        return res.status(500).json({ message: "Save failed" });
      }

      const questionnaireId = this.lastID;
      const deadlines = Array.isArray(data.deadlines) ? data.deadlines : [];

      db.run(`DELETE FROM deadlines WHERE user_id = ?`, [req.user.id], (deleteErr) => {
        if (deleteErr) {
          return res.status(500).json({ message: "Failed to reset deadlines" });
        }

        if (!deadlines.length) {
          return res.json({
            message: "Questionnaire saved",
            id: questionnaireId
          });
        }

        let completed = 0;
        let failed = false;

        deadlines.forEach((deadline) => {
          db.run(
            `
            INSERT INTO deadlines (user_id, title, type, due_date, note)
            VALUES (?, ?, ?, ?, ?)
            `,
            [
              req.user.id,
              deadline.title || "",
              deadline.type || "Deadline",
              deadline.due_date || "",
              deadline.note || ""
            ],
            (deadlineErr) => {
              if (failed) return;

              if (deadlineErr) {
                failed = true;
                return res.status(500).json({ message: "Failed to save deadlines" });
              }

              completed += 1;
              if (completed === deadlines.length) {
                res.json({
                  message: "Questionnaire saved",
                  id: questionnaireId
                });
              }
            }
          );
        });
      });
    }
  );
});

/* =========================
   UPDATE LATEST QUESTIONNAIRE
========================= */
app.put("/questionnaire/latest", auth, (req, res) => {
  const data = req.body;

  db.get(
    `
    SELECT id
    FROM questionnaires
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [req.user.id],
    (findErr, row) => {
      if (findErr) {
        return res.status(500).json({ message: "Database error" });
      }

      if (!row) {
        return res.status(404).json({ message: "No questionnaire found to update" });
      }

      db.run(
        `
        UPDATE questionnaires
        SET major = ?, year = ?, courses = ?, study_hours = ?, sleep_hours = ?, study_times = ?,
            available_days = ?, gpa = ?, goal = ?, dates = ?, study_methods = ?,
            length = ?, break_freq = ?, challenging = ?, study_challenges = ?
        WHERE id = ? AND user_id = ?
        `,
        [
          data.major || "",
          data.year || "",
          data.courses || "",
          data.study_hours || "",
          data.sleep_hours || "",
          data.study_times || "",
          JSON.stringify(data.available_days || []),
          data.gpa || "",
          data.goal || "",
          data.dates || "",
          JSON.stringify(data.study_methods || []),
          data.length || "",
          data.breakFreq || "",
          data.challenging || "",
          JSON.stringify(data.study_challenges || []),
          row.id,
          req.user.id
        ],
        function (updateErr) {
          if (updateErr) {
            return res.status(500).json({ message: "Failed to update questionnaire" });
          }

          const deadlines = Array.isArray(data.deadlines) ? data.deadlines : [];

          db.run(`DELETE FROM deadlines WHERE user_id = ?`, [req.user.id], (deleteErr) => {
            if (deleteErr) {
              return res.status(500).json({ message: "Failed to reset deadlines" });
            }

            if (!deadlines.length) {
              return res.json({
                message: "Questionnaire updated",
                id: row.id
              });
            }

            let completed = 0;
            let failed = false;

            deadlines.forEach((deadline) => {
              db.run(
                `
                INSERT INTO deadlines (user_id, title, type, due_date, note)
                VALUES (?, ?, ?, ?, ?)
                `,
                [
                  req.user.id,
                  deadline.title || "",
                  deadline.type || "Deadline",
                  deadline.due_date || "",
                  deadline.note || ""
                ],
                (deadlineErr) => {
                  if (failed) return;

                  if (deadlineErr) {
                    failed = true;
                    return res.status(500).json({ message: "Failed to save updated deadlines" });
                  }

                  completed += 1;
                  if (completed === deadlines.length) {
                    res.json({
                      message: "Questionnaire updated",
                      id: row.id
                    });
                  }
                }
              );
            });
          });
        }
      );
    }
  );
});

/* =========================
   GET LATEST QUESTIONNAIRE
========================= */
app.get("/questionnaire/latest", auth, async (req, res) => {
  db.get(
    `
    SELECT * FROM questionnaires
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [req.user.id],
    async (err, row) => {
      if (err) {
        return res.status(500).json({ message: "Database error" });
      }

      if (!row) {
        return res.status(404).json({ message: "No data found" });
      }

      try {
        const deadlines = await getUserDeadlines(req.user.id);

        res.json({
          ...row,
          available_days: JSON.parse(row.available_days || "[]"),
          study_methods: JSON.parse(row.study_methods || "[]"),
          study_challenges: JSON.parse(row.study_challenges || "[]"),
          deadlines
        });
      } catch {
        res.status(500).json({ message: "Failed to fetch deadlines" });
      }
    }
  );
});

/* =========================
   GET DEADLINES
========================= */
app.get("/deadlines", auth, async (req, res) => {
  try {
    const deadlines = await getUserDeadlines(req.user.id);
    res.json(deadlines);
  } catch {
    res.status(500).json({ message: "Failed to fetch deadlines" });
  }
});

/* =========================
   ADD DEADLINE / EVENT
========================= */
app.post("/deadlines", auth, (req, res) => {
  const { title, type, due_date, note } = req.body;

  if (!title || !type || !due_date) {
    return res.status(400).json({ message: "Title, type, and due date are required" });
  }

  db.run(
    `
    INSERT INTO deadlines (user_id, title, type, due_date, note)
    VALUES (?, ?, ?, ?, ?)
    `,
    [req.user.id, title, type, due_date, note || ""],
    function (err) {
      if (err) {
        return res.status(500).json({ message: "Failed to add event" });
      }

      res.json({
        message: "Event added",
        id: this.lastID
      });
    }
  );
});

/* =========================
   UPDATE DEADLINE / EVENT
========================= */
app.put("/deadlines/:id", auth, (req, res) => {
  const { id } = req.params;
  const { title, type, due_date, note } = req.body;

  if (!title || !type || !due_date) {
    return res.status(400).json({ message: "Title, type, and due date are required" });
  }

  db.run(
    `
    UPDATE deadlines
    SET title = ?, type = ?, due_date = ?, note = ?
    WHERE id = ? AND user_id = ?
    `,
    [title, type, due_date, note || "", id, req.user.id],
    function (err) {
      if (err) {
        return res.status(500).json({ message: "Failed to update event" });
      }

      if (this.changes === 0) {
        return res.status(404).json({ message: "Event not found" });
      }

      res.json({ message: "Event updated" });
    }
  );
});

/* =========================
   DELETE DEADLINE / EVENT
========================= */
app.delete("/deadlines/:id", auth, (req, res) => {
  const { id } = req.params;

  db.run(
    `
    DELETE FROM deadlines
    WHERE id = ? AND user_id = ?
    `,
    [id, req.user.id],
    function (err) {
      if (err) {
        return res.status(500).json({ message: "Failed to delete event" });
      }

      if (this.changes === 0) {
        return res.status(404).json({ message: "Event not found" });
      }

      res.json({ message: "Event deleted" });
    }
  );
});

/* =========================
   GENERATE AI STUDY PLAN
========================= */
app.post("/generate-study-plan", auth, (req, res) => {
  db.get(
    `
    SELECT * FROM questionnaires
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [req.user.id],
    async (err, row) => {
      if (err) {
        return res.status(500).json({ message: "Database error" });
      }

      if (!row) {
        return res.status(404).json({ message: "No questionnaire found" });
      }

      const questionnaire = {
        ...row,
        available_days: JSON.parse(row.available_days || "[]"),
        study_methods: JSON.parse(row.study_methods || "[]"),
        study_challenges: JSON.parse(row.study_challenges || "[]"),
        breakFreq: row.break_freq
      };

      try {
        const deadlines = await getUserDeadlines(req.user.id);
        const aiPlan = await generateAIStudyPlan(questionnaire, deadlines);

        db.run(
          `
          INSERT INTO ai_study_plans (
            user_id, questionnaire_id, summary, weekly_plan, priority_subjects, study_tips
          ) VALUES (?, ?, ?, ?, ?, ?)
          `,
          [
            req.user.id,
            row.id,
            aiPlan.summary || "",
            JSON.stringify(aiPlan.weekly_plan || []),
            JSON.stringify(aiPlan.priority_subjects || []),
            JSON.stringify(aiPlan.study_tips || [])
          ],
          function (insertErr) {
            if (insertErr) {
              return res.status(500).json({ message: "Failed to save AI study plan" });
            }

            const newPlanId = this.lastID;

            setActivePlan(req.user.id, newPlanId, (activeErr) => {
              if (activeErr) {
                return res.status(500).json({ message: "Failed to activate AI study plan" });
              }

              res.json({
                message: "AI study plan generated",
                id: newPlanId,
                plan: aiPlan
              });
            });
          }
        );
      } catch (aiError) {
        res.status(500).json({ message: aiError.message || "AI generation failed" });
      }
    }
  );
});

/* =========================
   GET ACTIVE / LATEST AI STUDY PLAN
========================= */
app.get("/study-plan/latest", auth, (req, res) => {
  db.get(
    `
    SELECT p.*
    FROM ai_study_plans p
    LEFT JOIN active_study_plan a
      ON a.plan_id = p.id AND a.user_id = p.user_id
    WHERE p.user_id = ?
    ORDER BY
      CASE WHEN a.plan_id IS NOT NULL THEN 0 ELSE 1 END,
      p.created_at DESC,
      p.id DESC
    LIMIT 1
    `,
    [req.user.id],
    (err, row) => {
      if (err) {
        return res.status(500).json({ message: "Database error" });
      }

      if (!row) {
        return res.status(404).json({ message: "No AI study plan found" });
      }

      res.json({
        ...row,
        weekly_plan: JSON.parse(row.weekly_plan || "[]"),
        priority_subjects: JSON.parse(row.priority_subjects || "[]"),
        study_tips: JSON.parse(row.study_tips || "[]")
      });
    }
  );
});

/* =========================
   GET ALL AI STUDY PLANS
========================= */
app.get("/study-plans", auth, (req, res) => {
  db.all(
    `
    SELECT
      p.id,
      p.user_id,
      p.questionnaire_id,
      p.summary,
      p.weekly_plan,
      p.priority_subjects,
      p.study_tips,
      p.created_at,
      CASE WHEN a.plan_id IS NOT NULL THEN 1 ELSE 0 END AS is_active
    FROM ai_study_plans p
    LEFT JOIN active_study_plan a
      ON a.plan_id = p.id AND a.user_id = p.user_id
    WHERE p.user_id = ?
    ORDER BY p.created_at DESC, p.id DESC
    `,
    [req.user.id],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ message: "Failed to fetch study plans" });
      }

      const plans = (rows || []).map((row) => ({
        ...row,
        weekly_plan: JSON.parse(row.weekly_plan || "[]"),
        priority_subjects: JSON.parse(row.priority_subjects || "[]"),
        study_tips: JSON.parse(row.study_tips || "[]")
      }));

      res.json(plans);
    }
  );
});

/* =========================
   ACTIVATE STUDY PLAN
========================= */
app.post("/study-plan/:id/activate", auth, (req, res) => {
  const { id } = req.params;

  db.get(
    `
    SELECT id
    FROM ai_study_plans
    WHERE id = ? AND user_id = ?
    `,
    [id, req.user.id],
    (err, row) => {
      if (err) {
        return res.status(500).json({ message: "Database error" });
      }

      if (!row) {
        return res.status(404).json({ message: "Study plan not found" });
      }

      setActivePlan(req.user.id, id, (activeErr) => {
        if (activeErr) {
          return res.status(500).json({ message: "Failed to activate study plan" });
        }

        res.json({ message: "Study plan activated" });
      });
    }
  );
});

/* =========================
   DELETE STUDY PLAN
========================= */
app.delete("/study-plan/:id", auth, (req, res) => {
  const { id } = req.params;

  db.get(
    `
    SELECT id
    FROM ai_study_plans
    WHERE id = ? AND user_id = ?
    `,
    [id, req.user.id],
    (findErr, row) => {
      if (findErr) {
        return res.status(500).json({ message: "Database error" });
      }

      if (!row) {
        return res.status(404).json({ message: "Study plan not found" });
      }

      db.get(
        `
        SELECT plan_id
        FROM active_study_plan
        WHERE user_id = ?
        `,
        [req.user.id],
        (activeErr, activeRow) => {
          if (activeErr) {
            return res.status(500).json({ message: "Database error" });
          }

          db.run(
            `
            DELETE FROM ai_study_plans
            WHERE id = ? AND user_id = ?
            `,
            [id, req.user.id],
            function (deleteErr) {
              if (deleteErr) {
                return res.status(500).json({ message: "Failed to delete study plan" });
              }

              const wasActive = activeRow && Number(activeRow.plan_id) === Number(id);

              if (!wasActive) {
                return res.json({ message: "Study plan deleted" });
              }

              db.run(
                `
                DELETE FROM active_study_plan
                WHERE user_id = ?
                `,
                [req.user.id],
                (clearErr) => {
                  if (clearErr) {
                    return res.status(500).json({ message: "Deleted plan, but failed to clear active plan" });
                  }

                  getLatestPlanId(req.user.id, (latestErr, latestRow) => {
                    if (latestErr) {
                      return res.status(500).json({ message: "Deleted plan, but failed to fetch replacement plan" });
                    }

                    if (!latestRow) {
                      return res.json({ message: "Study plan deleted" });
                    }

                    setActivePlan(req.user.id, latestRow.id, (setErr) => {
                      if (setErr) {
                        return res.status(500).json({ message: "Deleted plan, but failed to activate replacement plan" });
                      }

                      res.json({ message: "Study plan deleted" });
                    });
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

/* =========================
   ADD STUDY LOG
========================= */
app.post("/study-log", auth, (req, res) => {
  const { subject, hours, focus, notes } = req.body;

  if (!subject || !hours) {
    return res.status(400).json({ message: "Subject and hours are required" });
  }

  db.run(
    `
    INSERT INTO study_logs (user_id, subject, hours, focus, notes)
    VALUES (?, ?, ?, ?, ?)
    `,
    [
      req.user.id,
      subject,
      Number(hours),
      Number(focus) || 0,
      notes || ""
    ],
    function (err) {
      if (err) {
        return res.status(500).json({ message: "Failed to save log" });
      }

      res.json({
        message: "Study session logged",
        id: this.lastID
      });
    }
  );
});

/* =========================
   GET STUDY LOGS
========================= */
app.get("/study-log", auth, (req, res) => {
  db.all(
    `
    SELECT * FROM study_logs
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    `,
    [req.user.id],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ message: "Failed to fetch logs" });
      }

      res.json(rows || []);
    }
  );
});

/* =========================
   UPDATE STUDY LOG
========================= */
app.put("/study-log/:id", auth, (req, res) => {
  const { id } = req.params;
  const { subject, hours, focus, notes } = req.body;

  db.run(
    `
    UPDATE study_logs
    SET subject = ?, hours = ?, focus = ?, notes = ?
    WHERE id = ? AND user_id = ?
    `,
    [
      subject || "",
      Number(hours) || 0,
      Number(focus) || 0,
      notes || "",
      id,
      req.user.id
    ],
    function (err) {
      if (err) {
        return res.status(500).json({ message: "Failed to update log" });
      }

      if (this.changes === 0) {
        return res.status(404).json({ message: "Log not found" });
      }

      res.json({ message: "Study log updated" });
    }
  );
});

/* =========================
   DELETE STUDY LOG
========================= */
app.delete("/study-log/:id", auth, (req, res) => {
  const { id } = req.params;

  db.run(
    `
    DELETE FROM study_logs
    WHERE id = ? AND user_id = ?
    `,
    [id, req.user.id],
    function (err) {
      if (err) {
        return res.status(500).json({ message: "Failed to delete log" });
      }

      if (this.changes === 0) {
        return res.status(404).json({ message: "Log not found" });
      }

      res.json({ message: "Study log deleted" });
    }
  );
});

/* =========================
   GENERATE PROGRESS INSIGHTS
========================= */
app.get("/progress-insights", auth, (req, res) => {
  db.get(
    `
    SELECT * FROM questionnaires
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [req.user.id],
    (questionnaireErr, questionnaireRow) => {
      if (questionnaireErr) {
        return res.status(500).json({ message: "Failed to fetch questionnaire" });
      }

      if (!questionnaireRow) {
        return res.status(404).json({ message: "No questionnaire found" });
      }

      db.all(
        `
        SELECT * FROM study_logs
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        `,
        [req.user.id],
        async (logsErr, logsRows) => {
          if (logsErr) {
            return res.status(500).json({ message: "Failed to fetch study logs" });
          }

          const questionnaire = {
            ...questionnaireRow,
            available_days: JSON.parse(questionnaireRow.available_days || "[]"),
            study_methods: JSON.parse(questionnaireRow.study_methods || "[]"),
            study_challenges: JSON.parse(questionnaireRow.study_challenges || "[]"),
            breakFreq: questionnaireRow.break_freq
          };

          try {
            const insights = await generateProgressInsights({
              questionnaire,
              logs: logsRows || []
            });

            res.json(insights);
          } catch (aiError) {
            res.status(500).json({ message: aiError.message || "Progress insight generation failed" });
          }
        }
      );
    }
  );
});

/* =========================
   SAVE SETTINGS
========================= */
app.post("/settings", auth, (req, res) => {
  const data = req.body;

  db.get(
    "SELECT * FROM settings WHERE user_id = ?",
    [req.user.id],
    (checkErr, existingRow) => {
      if (checkErr) {
        return res.status(500).json({ message: "Database error" });
      }

      if (existingRow) {
        db.run(
          `
          UPDATE settings
          SET name = ?, email = ?, university = ?, major = ?,
              hours = ?, break_length = ?, notifications = ?, intensity = ?, theme = ?, start_page = ?
          WHERE user_id = ?
          `,
          [
            data.name || "",
            data.email || "",
            data.university || "",
            data.major || "",
            data.hours || "",
            data.break_length || "",
            JSON.stringify(data.notifications || []),
            data.intensity || "",
            data.theme || "System",
            data.start_page || "Home",
            req.user.id
          ],
          function (updateErr) {
            if (updateErr) {
              return res.status(500).json({ message: "Save failed" });
            }

            res.json({ message: "Settings updated" });
          }
        );
      } else {
        db.run(
          `
          INSERT INTO settings (
            user_id, name, email, university, major,
            hours, break_length, notifications, intensity, theme, start_page
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            req.user.id,
            data.name || "",
            data.email || "",
            data.university || "",
            data.major || "",
            data.hours || "",
            data.break_length || "",
            JSON.stringify(data.notifications || []),
            data.intensity || "",
            data.theme || "System",
            data.start_page || "Home"
          ],
          function (insertErr) {
            if (insertErr) {
              return res.status(500).json({ message: "Save failed" });
            }

            res.json({ message: "Settings saved" });
          }
        );
      }
    }
  );
});

/* =========================
   GET SETTINGS
========================= */
app.get("/settings", auth, (req, res) => {
  db.get(
    "SELECT * FROM settings WHERE user_id = ?",
    [req.user.id],
    (err, row) => {
      if (err) {
        return res.status(500).json({ message: "Database error" });
      }

      if (!row) {
        return res.json({});
      }

      res.json({
        ...row,
        notifications: JSON.parse(row.notifications || "[]")
      });
    }
  );
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});