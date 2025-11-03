// routes/users.js
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');

module.exports = function () {
  const router = express.Router();
  const usersRoute = router.route('/');
  const userRoute  = router.route('/:id');

  // ---------- helpers ----------
  function parseJSON(q, fieldName) {
    if (!q) return null;
    try {
      return JSON.parse(q);
    } catch {
      const err = new Error(`Invalid JSON in "${fieldName}"`);
      err.status = 400;
      throw err;
    }
  }
  function isBadIdCast(err) {
    return err && err.name === 'CastError' && err.path === '_id';
  }
  function objectIdLike(v) {
    return typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
  }
  function cleanIds(arr) {
    return (Array.isArray(arr) ? arr : []).map(String);
  }

  // Validate that every pending task:
  // - is a valid ObjectId
  // - exists
  // - is NOT completed
  // - is NOT assigned to another user (unless that userId equals currentUserId)
  async function validatePendingTasksOrThrow(taskIds, currentUserId, session) {
    const ids = cleanIds(taskIds);

    for (const id of ids) {
      if (!objectIdLike(id)) {
        const err = new Error(`Invalid task id: ${id}`);
        err.status = 400;
        throw err;
      }
    }
    if (ids.length === 0) return;

    const tasks = await Task.find({ _id: { $in: ids } })
      .select({ _id: 1, completed: 1, assignedUser: 1 })
      .session(session || null);

    if (tasks.length !== ids.length) {
      const found = new Set(tasks.map(t => String(t._id)));
      const missing = ids.filter(id => !found.has(id));
      const err = new Error(`Some tasks do not exist: ${missing.join(', ')}`);
      err.status = 400;
      throw err;
    }

    const completed = tasks.filter(t => t.completed).map(t => String(t._id));
    if (completed.length) {
      const err = new Error(`Tasks must be pending (not completed): ${completed.join(', ')}`);
      err.status = 400;
      throw err;
    }

    const conflicted = tasks
      .filter(t => t.assignedUser && String(t.assignedUser) !== String(currentUserId))
      .map(t => String(t._id));
    if (conflicted.length) {
      const err = new Error(`Tasks already assigned to another user: ${conflicted.join(', ')}`);
      err.status = 409; // conflict
      throw err;
    }
  }

  // ---------- GET /api/users ----------
  usersRoute.get(async (req, res) => {
    try {
      const where = parseJSON(req.query.where, 'where') || {};

      // count-only path
      if (req.query.count === 'true') {
        const count = await User.countDocuments(where);
        return res.status(200).json({ message: 'OK', data: count });
      }

      // list path
      let query = User.find(where);

      const sort   = parseJSON(req.query.sort, 'sort');
      const select = parseJSON(req.query.select, 'select');
      if (sort)   query = query.sort(sort);
      if (select) query = query.select(select);
      else        query = query.select('-__v'); // default hide __v

      if (req.query.skip) {
        const n = parseInt(req.query.skip, 10);
        if (!Number.isNaN(n)) query = query.skip(n);
      }
      if (req.query.limit) {
        const n = parseInt(req.query.limit, 10);
        if (!Number.isNaN(n) && n > 0) query = query.limit(n);
      } // users: default unlimited

      const users = await query.exec();
      return res.status(200).json({ message: 'OK', data: users });
    } catch (e) {
      const status = e.status || 500;
      const msg = e.status === 400 ? e.message : 'Error getting users';
      return res.status(status).json({ message: msg, data: {} });
    }
  });

  // ---------- POST /api/users ----------
  usersRoute.post(async (req, res) => {
    const session = await User.startSession();
    try {
      let saved;
      await session.withTransaction(async () => {
        const rawPending = cleanIds(req.body?.pendingTasks);
        const pendingTasks = Array.from(new Set(rawPending));

        // Validate pending tasks before creating user (currentUserId is null for new user)
        if (pendingTasks.length) {
          await validatePendingTasksOrThrow(pendingTasks, null, session);
        }

        // Create and save user
        const user = new User({
          name:  req.body?.name,
          email: req.body?.email,
          pendingTasks: pendingTasks,
          dateCreated: new Date()
        });

        saved = await user.save({ session });

        // Two-way maintenance: update tasks to assign them to this new user
        if (pendingTasks.length) {
          await Task.updateMany(
            { _id: { $in: pendingTasks } },
            { $set: { assignedUser: String(saved._id), assignedUserName: saved.name } },
            { session }
          );
        }

        res.status(201).json({ message: 'User created successfully', data: saved });
      });
    } catch (err) {
      if (err.status === 400 || err.status === 409) {
        return res.status(err.status).json({ message: err.message, data: {} });
      }
      if (err.name === 'ValidationError') {
        return res.status(400).json({ message: 'Invalid user data', data: {} });
      }
      if (err.code === 11000) {
        return res.status(409).json({ message: 'User with this email already exists', data: {} });
      }
      return res.status(500).json({ message: 'Error creating user', data: {} });
    } finally {
      session.endSession();
    }
  });

  // ---------- GET /api/users/:id ----------
  userRoute.get(async (req, res) => {
    try {
      const select = parseJSON(req.query.select, 'select') || { __v: 0 };
      const user = await User.findById(req.params.id).select(select).exec();
      if (!user) {
        return res.status(404).json({ message: 'User not found', data: {} });
      }
      return res.status(200).json({ message: 'OK', data: user });
    } catch (err) {
      if (isBadIdCast(err)) {
        return res.status(404).json({ message: 'User not found', data: {} });
      }
      return res.status(500).json({ message: 'Error getting user', data: {} });
    }
  });

  // ---------- PUT /api/users/:id ----------
  // Replace entire user. Validates pendingTasks; maintains two-way consistency in a transaction.
  userRoute.put(async (req, res) => {
    const session = await User.startSession();
    try {
      await session.withTransaction(async () => {
        const user = await User.findById(req.params.id).session(session);
        if (!user) {
          res.status(404).json({ message: 'User not found', data: {} });
          return;
        }

        // Next values
        const nextName  = req.body?.name;
        const nextEmail = req.body?.email;
        const rawNextPending = cleanIds(req.body?.pendingTasks ?? user.pendingTasks);
        const nextPending = Array.from(new Set(rawNextPending));

        // Validate pending tasks for conflicts/completion/etc.
        await validatePendingTasksOrThrow(nextPending, user._id, session);

        const oldPending = new Set(cleanIds(user.pendingTasks));
        const newPending = new Set(nextPending);

        // Overwrite (schema validation for required fields, unique email)
        user.name = nextName;
        user.email = nextEmail;
        user.pendingTasks = Array.from(newPending);

        const updated = await user.save({ session });

        // Two-way maintenance (inside the same transaction)
        const removed = [...oldPending].filter(id => !newPending.has(id));
        if (removed.length) {
          await Task.updateMany(
            { _id: { $in: removed }, assignedUser: String(user._id) },
            { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
            { session }
          );
        }

        const added = [...newPending].filter(id => !oldPending.has(id));
        if (added.length) {
          await Task.updateMany(
            { _id: { $in: added } },
            { $set: { assignedUser: String(user._id), assignedUserName: updated.name } },
            { session }
          );
        }

        res.status(200).json({ message: 'User updated successfully', data: updated });
      });
    } catch (err) {
      if (isBadIdCast(err)) {
        return res.status(404).json({ message: 'User not found', data: {} });
      }
      if (err.status === 400 || err.status === 409) {
        return res.status(err.status).json({ message: err.message, data: {} });
      }
      if (err.code === 11000) {
        return res.status(409).json({ message: 'User with this email already exists', data: {} });
      }
      if (err.name === 'ValidationError') {
        return res.status(400).json({ message: 'Invalid user data', data: {} });
      }
      return res.status(500).json({ message: 'Error updating user', data: {} });
    } finally {
      session.endSession();
    }
  });

  // ---------- DELETE /api/users/:id ----------
  userRoute.delete(async (req, res) => {
    const session = await User.startSession();
    try {
      await session.withTransaction(async () => {
        const user = await User.findById(req.params.id).session(session);
        if (!user) {
          res.status(404).json({ message: 'User not found', data: {} });
          return;
        }

        // Unassign this user's tasks in the same transaction
        await Task.updateMany(
          { assignedUser: String(user._id) },
          { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
          { session }
        );

        await User.deleteOne({ _id: user._id }, { session });

        // Assignment requires 204 for delete (no body)
        res.status(204).send();
      });
    } catch (err) {
      if (isBadIdCast(err)) {
        return res.status(404).json({ message: 'User not found', data: {} });
      }
      return res.status(500).json({ message: 'Error deleting user', data: {} });
    } finally {
      session.endSession();
    }
  });

  return router;
};