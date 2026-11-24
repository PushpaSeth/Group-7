require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_FILE || path.join(__dirname, 'data', 'subscriptions.db');

const {
  validateSubscriptionPayload,
  VALID_STATUSES
} = require('./validation.js');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// Initialize schema
const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schemaSql);

// Optional --seed flag to load clean fictional test data
if (process.argv.includes('--seed')) {
  const seedSql = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
  db.exec(seedSql);
  console.log('Database seeded successfully with P1 fictional test records.');
  if (process.argv.includes('--exit')) process.exit(0);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

//const VALID_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'annual'];
//const VALID_STATUSES = ['active', 'paused', 'canceled'];

/**
 * Converts billing amount_cents and frequency into standardized integer annual_cents
 * and monthly_equivalent_cents using standard half-up integer rounding (Math.round).
 */
function calculateAnnualizedMetrics(amountCents, frequency) {
  const multipliers = {
    weekly: 52,
    monthly: 12,
    quarterly: 4,
    annual: 1
  };
  const annualCents = amountCents * multipliers[frequency];
  const monthlyEquivalentCents = Math.round(annualCents / 12);
  return { annualCents, monthlyEquivalentCents };
}

/**
 * Computes signed savings delta in cents when transitioning between statuses.
 * Prevents double counting on repeated status toggles (active -> canceled -> active -> canceled).
 */
function computeSavingsDeltaCents(previousStatus, newStatus, annualCents) {
  if (previousStatus === newStatus) return 0;
  if (previousStatus !== 'canceled' && newStatus === 'canceled') {
    return annualCents; // Reclaimed annual cash flow
  }
  if (previousStatus === 'canceled' && newStatus !== 'canceled') {
    return -annualCents; // Re-activated or paused; removes previously claimed savings
  }
  return 0; // active <-> paused does not count as canceled savings
}

// GET /api/categories
app.get('/api/categories', (req, res) => {
  try {
    const categories = db.prepare('SELECT id, name FROM categories ORDER BY id ASC').all();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories.' });
  }
});

// GET /api/subscriptions
app.get('/api/subscriptions', (req, res) => {
  try {
    const { category_id } = req.query;
    let query = `
      SELECT s.id, s.name, s.category_id, c.name AS category_name,
             s.amount_cents, s.frequency, s.status, s.created_at
      FROM subscriptions s
      JOIN categories c ON s.category_id = c.id
    `;
    const params = [];
    if (category_id && category_id !== 'all') {
      query += ' WHERE s.category_id = ?';
      params.push(Number(category_id));
    }
    query += ' ORDER BY s.id ASC';

    const rows = db.prepare(query).all(...params);
    const enriched = rows.map((row) => {
      const { annualCents, monthlyEquivalentCents } = calculateAnnualizedMetrics(
        row.amount_cents,
        row.frequency
      );
      return {
        ...row,
        annual_cents: annualCents,
        monthly_equivalent_cents: monthlyEquivalentCents
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve subscriptions.' });
  }
});

// GET /api/summary
app.get('/api/summary', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.id, s.amount_cents, s.frequency, s.status, c.name AS category_name
      FROM subscriptions s
      JOIN categories c ON s.category_id = c.id
    `).all();

    let activeAnnualOutflowCents = 0;
    let reclaimedAnnualSavingsCents = 0;
    let activeCount = 0;
    const categoryBreakdown = {};

    for (const row of rows) {
      const { annualCents } = calculateAnnualizedMetrics(row.amount_cents, row.frequency);
      if (row.status === 'active') {
        activeAnnualOutflowCents += annualCents;
        activeCount += 1;
        categoryBreakdown[row.category_name] = (categoryBreakdown[row.category_name] || 0) + annualCents;
      } else if (row.status === 'canceled') {
        reclaimedAnnualSavingsCents += annualCents;
      }
    }

    const monthlyOutflowCents = Math.round(activeAnnualOutflowCents / 12);
    const recentLogs = db.prepare(`
      SELECT a.id, a.subscription_id, s.name AS subscription_name,
             a.previous_status, a.new_status, a.annual_savings_delta_cents, a.changed_at
      FROM audit_logs a
      JOIN subscriptions s ON a.subscription_id = s.id
      ORDER BY a.id DESC
      LIMIT 10
    `).all();

    res.json({
      active_annual_outflow_cents: activeAnnualOutflowCents,
      monthly_outflow_cents: monthlyOutflowCents,
      reclaimed_annual_savings_cents: reclaimedAnnualSavingsCents,
      active_subscriptions_count: activeCount,
      total_subscriptions_count: rows.length,
      category_breakdown_cents: categoryBreakdown,
      recent_audit_logs: recentLogs
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate summary metrics.' });
  }
});

// POST /api/subscriptions
app.post('/api/subscriptions', (req, res) => {
  const validation = validateSubscriptionPayload(req.body);
  if (!validation.isValid) {
    return res.status(400).json({ error: validation.errors.join(' ') });
  }

  const { name, categoryId, amountCents, frequency, status } = validation.cleaned;

  try {
    // Verify that the selected category exists before inserting the subscription in the database.
    const categoryExists = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
    if (!categoryExists) {
      return res.status(400).json({ error: 'Selected category does not exist.' });
    }

    const info = db.prepare(`
      INSERT INTO subscriptions (category_id, name, amount_cents, frequency, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(categoryId, name, amountCents, frequency, status);

    const created = db.prepare(`
      SELECT s.*, c.name AS category_name
      FROM subscriptions s
      JOIN categories c ON s.category_id = c.id
      WHERE s.id = ?
    `).get(info.lastInsertRowid);

    const { annualCents, monthlyEquivalentCents } = calculateAnnualizedMetrics(
      created.amount_cents,
      created.frequency
    );

    res.status(201).json({
      ...created,
      annual_cents: annualCents,
      monthly_equivalent_cents: monthlyEquivalentCents
    });
  } catch (err) {
    console.error('Failed to create subscription:', err);
    res.status(500).json({ error: 'Database error while creating subscription.' });
  }
});

// PUT /api/subscriptions/:id
app.put('/api/subscriptions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid subscription ID.' });
  }

  const existing = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: `Subscription with ID ${id} not found.` });
  }
  // Validate the request payload and preserve the existing subscription status if no new status is provided.
  const validation = validateSubscriptionPayload(req.body,existing.status);

  if (!validation.isValid) {
    return res.status(400).json({
      error: validation.errors.join(' ')
    });
  }

  const { name, categoryId, amountCents, frequency, status } = validation.cleaned;

  try {
    // Verify that the selected category exists before updating the subscription in the database.
    const categoryExists = db.prepare(
      'SELECT id FROM categories WHERE id = ?'
      ).get(categoryId);

    if (!categoryExists) {
      return res.status(400).json({
        error: 'Selected category does not exist.'
      });
    }
    const updateTx = db.transaction(() => {
      db.prepare(`
        UPDATE subscriptions
        SET name = ?, category_id = ?, amount_cents = ?, frequency = ?, status = ?
        WHERE id = ?
      `).run(name, categoryId, amountCents, frequency, status, id);

    if (existing.status !== status) {
        const { annualCents } = calculateAnnualizedMetrics(amountCents, frequency);
        const deltaCents = computeSavingsDeltaCents(existing.status, status, annualCents);
        db.prepare(`
          INSERT INTO audit_logs (subscription_id, previous_status, new_status, annual_savings_delta_cents)
          VALUES (?, ?, ?, ?)
        `).run(id, existing.status, status, deltaCents);
      }
    });

    updateTx();

    const updated = db.prepare(`
      SELECT s.*, c.name AS category_name
      FROM subscriptions s
      JOIN categories c ON s.category_id = c.id
      WHERE s.id = ?
    `).get(id);

    const { annualCents, monthlyEquivalentCents } = calculateAnnualizedMetrics(
      updated.amount_cents,
      updated.frequency
    );

    res.json({
      ...updated,
      annual_cents: annualCents,
      monthly_equivalent_cents: monthlyEquivalentCents
    });
  } 
  catch (err) {
    console.error('Failed to update subscription:', err);
    res.status(500).json({ error: 'Failed to update subscription.' });
  }
});

// PATCH /api/subscriptions/:id/status
app.patch('/api/subscriptions/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const { status: newStatus } = req.body;

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid subscription ID.' });
  }
  if (!VALID_STATUSES.includes(newStatus)) {
    return res.status(400).json({
      error: `Status must be one of: ${VALID_STATUSES.join(', ')}.`
    });
  }

  const existing = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: `Subscription with ID ${id} not found.` });
  }

  if (existing.status === newStatus) {
    const { annualCents, monthlyEquivalentCents } = calculateAnnualizedMetrics(
      existing.amount_cents,
      existing.frequency
    );
    return res.json({
      ...existing,
      annual_cents: annualCents,
      monthly_equivalent_cents: monthlyEquivalentCents,
      savings_delta_cents: 0
    });
  }

  const { annualCents, monthlyEquivalentCents } = calculateAnnualizedMetrics(
    existing.amount_cents,
    existing.frequency
  );
  const deltaCents = computeSavingsDeltaCents(existing.status, newStatus, annualCents);

  try {
    const statusTx = db.transaction(() => {
      db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').run(newStatus, id);
      db.prepare(`
        INSERT INTO audit_logs (subscription_id, previous_status, new_status, annual_savings_delta_cents)
        VALUES (?, ?, ?, ?)
      `).run(id, existing.status, newStatus, deltaCents);
    });

    statusTx();

    const updated = db.prepare(`
      SELECT s.*, c.name AS category_name
      FROM subscriptions s
      JOIN categories c ON s.category_id = c.id
      WHERE s.id = ?
    `).get(id);

    res.json({
      ...updated,
      annual_cents: annualCents,
      monthly_equivalent_cents: monthlyEquivalentCents,
      savings_delta_cents: deltaCents
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update subscription status.' });
  }
});

// DELETE /api/subscriptions/:id
app.delete('/api/subscriptions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid subscription ID.' });
  }

  const existing = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: `Subscription with ID ${id} not found.` });
  }

  try {
    db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
    res.json({ message: `Subscription "${existing.name}" (ID ${id}) deleted.`, deleted_id: id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete subscription.' });
  }
});

// Unknown API routes return a JSON 404 instead of an HTML page
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

// Malformed JSON and unexpected errors return JSON (no stack traces)
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  console.error(err);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

app.listen(PORT, () => {
  console.log(`Subscription Tracker server running at http://localhost:${PORT}`);
});
