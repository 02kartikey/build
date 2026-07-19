/* ════════════════════════════════════════════════════════════════════
   counsellor-goals-routes.js — NuMind MAPS
   --------------------------------------------------------------------
   HTTP handlers for the student "About me" context and milestones.
   Decoupled from server.js: the server injects its own helpers
   (_json, _readBody, _verifyCounsellorToken, _checkToken) so this
   module never reaches into server internals.

   Mount in server.js:

     const goals       = require('./counsellor-goals-db.js');
     const goalRoutes  = require('./counsellor-goals-routes.js')({
       json:                 _json,
       readBody:             _readBody,
       verifyCounsellorToken: _verifyCounsellorToken,
       checkToken:           _checkToken,
     });

   Then in the dispatch block:

     if (method === 'GET'    && pathname === '/api/counsellor-context')    return await goalRoutes.getContext(req, res);
     if (method === 'PUT'    && pathname === '/api/counsellor-context')    return await goalRoutes.putContext(req, res);
     if (method === 'GET'    && pathname === '/api/counsellor-milestones') return await goalRoutes.listMilestones(req, res);
     if (method === 'POST'   && pathname === '/api/counsellor-milestones') return await goalRoutes.addMilestone(req, res);
     if (method === 'PATCH'  && pathname === '/api/counsellor-milestones') return await goalRoutes.patchMilestone(req, res);
     if (method === 'DELETE' && pathname === '/api/counsellor-milestones') return await goalRoutes.deleteMilestone(req, res);
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const goals = require('./counsellor-goals-db.js');

module.exports = function createGoalRoutes(ctx) {
  const { json, readBody, verifyCounsellorToken, checkToken } = ctx || {};
  if (!json || !readBody || !verifyCounsellorToken || !checkToken) {
    throw new Error('counsellor-goals-routes: missing injected helpers');
  }

  /* Shared gate: app token + counsellor token → student email, or null with
     the response already sent. */
  async function _auth(req, res) {
    if (!checkToken(req)) { json(res, 401, { error: 'Unauthorized' }); return null; }
    const email = await verifyCounsellorToken(req);
    if (!email) { json(res, 401, { error: 'Session expired. Please re-enter your email to continue.' }); return null; }
    return email;
  }

  async function _body(req, res) {
    try { return await readBody(req, 32 * 1024); }
    catch { json(res, 400, { error: 'Bad request' }); return null; }
  }

  /* ── Custom context ("About me") ──────────────────────────────── */

  async function getContext(req, res) {
    const email = await _auth(req, res); if (!email) return;
    try {
      const ctxData = await goals.getCustomContext(email);
      json(res, 200, { ok: true, context: ctxData });
    } catch (err) {
      json(res, 500, { error: 'Could not load your info.' });
    }
  }

  async function putContext(req, res) {
    const email = await _auth(req, res); if (!email) return;
    const body = await _body(req, res); if (body === null) return;
    try {
      const result = await goals.saveCustomContext(email, {
        fields: body.fields || {},
        notes:  body.notes  || '',
      });
      if (!result.ok) return json(res, 400, { error: result.error || 'Could not save.' });
      json(res, 200, { ok: true, context: { fields: result.fields, notes: result.notes } });
    } catch (err) {
      json(res, 500, { error: 'Could not save your info.' });
    }
  }

  /* ── Milestones ───────────────────────────────────────────────── */

  async function listMilestones(req, res) {
    const email = await _auth(req, res); if (!email) return;
    try {
      const list = await goals.getMilestones(email);
      json(res, 200, { ok: true, milestones: list });
    } catch (err) {
      json(res, 500, { error: 'Could not load milestones.' });
    }
  }

  /* Create — used by the chat "Accept" card (source 'aria') and any manual
     add (source 'student'). */
  async function addMilestone(req, res) {
    const email = await _auth(req, res); if (!email) return;
    const body = await _body(req, res); if (body === null) return;
    try {
      const result = await goals.addMilestone(email, {
        title:       body.title,
        detail:      body.detail,
        target_date: body.target_date,
        source:      body.source,
      });
      if (!result.ok) {
        const code = result.error === 'title_required' ? 400 : result.error === 'no_session' ? 404 : 400;
        return json(res, code, { error: result.error === 'title_required' ? 'A title is required.' : 'Could not add milestone.' });
      }
      json(res, 201, { ok: true, milestone: result.milestone });
    } catch (err) {
      json(res, 500, { error: 'Could not add milestone.' });
    }
  }

  /* Update: `{ id, status }` toggles complete/active; `{ id, title|detail|target_date }`
     edits fields. */
  async function patchMilestone(req, res) {
    const email = await _auth(req, res); if (!email) return;
    const body = await _body(req, res); if (body === null) return;
    const id = Number(body.id);
    if (!id) return json(res, 400, { error: 'id is required.' });
    try {
      let result;
      if (body.status != null) {
        result = await goals.setMilestoneStatus(email, id, body.status === 'completed' ? 'completed' : 'active');
      } else {
        result = await goals.updateMilestone(email, id, {
          title:       body.title,
          detail:      body.detail,
          target_date: body.target_date,
        });
      }
      if (!result.ok) {
        const code = result.error === 'not_found' ? 404 : 400;
        return json(res, code, { error: result.error === 'not_found' ? 'Milestone not found.' : 'Could not update milestone.' });
      }
      json(res, 200, { ok: true, milestone: result.milestone });
    } catch (err) {
      json(res, 500, { error: 'Could not update milestone.' });
    }
  }

  async function deleteMilestone(req, res) {
    const email = await _auth(req, res); if (!email) return;
    const body = await _body(req, res); if (body === null) return;
    const id = Number(body.id);
    if (!id) return json(res, 400, { error: 'id is required.' });
    try {
      await goals.deleteMilestone(email, id);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: 'Could not delete milestone.' });
    }
  }

  return { getContext, putContext, listMilestones, addMilestone, patchMilestone, deleteMilestone };
};
