// routes/users.js
const express = require('express');
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
  function isCastError(err) {
    return err && err.name === 'CastError' && err.path === '_id';
  }

  // ---------- GET /api/users ----------
  usersRoute.get(async function (req, res) {
    try {
      const where = parseJSON(req.query.where, 'where') || {};

      // count path
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
      return res.status(status).json({ message: e.message || 'Error getting users', data: {} });
    }
  });

  // ---------- POST /api/users ----------
  usersRoute.post(async function (req, res) {
    try {
      if (!req.body?.name || !req.body?.email) {
        return res.status(400).json({ message: 'name and email are required', data: {} });
      }

      const user = new User(req.body);
      user.dateCreated = new Date();

      await user.save();
      return res.status(201).json({ message: 'User created successfully', data: user });
    } catch (err) {
      if (err.name === 'ValidationError') {
        return res.status(400).json({ message: 'Validation error', data: err });
      }
      if (err.code === 11000) {
        return res.status(409).json({ message: 'User with this email already exists', data: err });
      }
      return res.status(500).json({ message: 'Error creating user', data: err });
    }
  });

  // ---------- GET /api/users/:id ----------
  userRoute.get(async function (req, res) {
    try {
      const select = parseJSON(req.query.select, 'select') || { __v: 0 };
      const user = await User.findById(req.params.id).select(select).exec();
      if (!user) {
        return res.status(404).json({ message: 'User not found', data: {} });
      }
      return res.status(200).json({ message: 'OK', data: user });
    } catch (err) {
      if (isCastError(err)) {
        return res.status(404).json({ message: 'User not found', data: {} });
      }
      return res.status(500).json({ message: 'Error getting user', data: {} });
    }
  });

  // ---------- PUT /api/users/:id ----------
  // Replace the entire user; name and email are required.
  userRoute.put(async function (req, res) {
    try {
      const user = await User.findById(req.params.id).exec();
      if (!user) {
        return res.status(404).json({ message: 'User not found', data: {} });
      }

      const { name, email, pendingTasks } = req.body || {};
      if (!name || !email) {
        return res.status(400).json({
          message: 'name and email are required for PUT',
          data: {}
        });
      }

      // Snapshot for two-way maintenance
      const oldPending = new Set((user.pendingTasks || []).map(String));
      const newPending = new Set((pendingTasks || []).map(String));

      // Replace the whole resource (reasonable defaults)
      user.name = name;
      user.email = email;
      user.pendingTasks = Array.from(newPending);

      const updated = await user.save();

      // Two-way maintenance:
      // 1) Tasks removed from user's pending → unassign if currently assigned to this user
      const removed = [...oldPending].filter(id => !newPending.has(id));
      if (removed.length) {
        await Task.updateMany(
          { _id: { $in: removed }, assignedUser: String(user._id) },
          { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
        );
      }

      // 2) Tasks added to user's pending → assign to this user
      const added = [...newPending].filter(id => !oldPending.has(id));
      if (added.length) {
        await Task.updateMany(
          { _id: { $in: added } },
          { $set: { assignedUser: String(user._id), assignedUserName: user.name } }
        );
      }

      return res.status(200).json({ message: 'User updated successfully', data: updated });
    } catch (err) {
      if (isCastError(err)) {
        return res.status(404).json({ message: 'User not found', data: {} });
      }
      if (err.code === 11000) {
        return res.status(409).json({ message: 'User with this email already exists', data: err });
      }
      if (err.name === 'ValidationError') {
        return res.status(400).json({ message: 'Validation error', data: err });
      }
      return res.status(500).json({ message: 'Error updating user', data: err });
    }
  });

  // ---------- DELETE /api/users/:id ----------
  userRoute.delete(async function (req, res) {
    try {
      const user = await User.findById(req.params.id).exec();
      if (!user) {
        return res.status(404).json({ message: 'User not found', data: {} });
      }

      // Unassign this user's tasks
      await Task.updateMany(
        { assignedUser: String(user._id) },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
      );

      await User.deleteOne({ _id: user._id });

      // Return JSON per assignment's "always message+data"
      return res.status(200).json({ message: 'User deleted successfully', data: {} });
    } catch (err) {
      if (isCastError(err)) {
        return res.status(404).json({ message: 'User not found', data: {} });
      }
      return res.status(500).json({ message: 'Error deleting user', data: err });
    }
  });

  return router;
};