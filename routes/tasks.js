// routes/tasks.js
const express = require('express');
const Task = require('../models/task');
const User = require('../models/user');

module.exports = function () {
  const router = express.Router();
  const tasksRoute = router.route('/');
  const taskRoute  = router.route('/:id');

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
  async function ensureUserExists(userId) {
    if (!userId) return null;
    const u = await User.findById(userId).select({ name: 1 }).exec();
    if (!u) {
      const err = new Error('assignedUser not found');
      err.status = 400;
      throw err;
    }
    return u;
  }

  // ---------- GET /api/tasks ----------
  tasksRoute.get(async function (req, res) {
    try {
      const where = parseJSON(req.query.where, 'where') || {};

      // Count path: only apply "where"
      if (req.query.count === 'true') {
        const count = await Task.countDocuments(where);
        return res.status(200).json({ message: 'OK', data: count });
      }

      // List path
      let query = Task.find(where);

      const sort   = parseJSON(req.query.sort, 'sort');
      const select = parseJSON(req.query.select, 'select');

      if (sort)   query = query.sort(sort);
      if (select) query = query.select(select);
      else        query = query.select('-__v'); // default: hide __v

      if (req.query.skip) {
        const n = parseInt(req.query.skip, 10);
        if (!Number.isNaN(n)) query = query.skip(n);
      }
      if (req.query.limit) {
        const n = parseInt(req.query.limit, 10);
        if (!Number.isNaN(n) && n > 0) query = query.limit(n);
      } else {
        // tasks default limit = 100 (per spec)
        query = query.limit(100);
      }

      const tasks = await query.exec();
      return res.status(200).json({ message: 'OK', data: tasks });
    } catch (e) {
      const status = e.status || 500;
      return res.status(status).json({ message: e.message || 'Error getting tasks', data: {} });
    }
  });

  // ---------- POST /api/tasks ----------
  tasksRoute.post(async function (req, res) {
    try {
      const body = req.body || {};
      if (!body.name || !body.deadline) {
        return res.status(400).json({ message: 'name and deadline are required', data: {} });
      }

      // If assignedUser is provided (non-empty), make sure it exists
      let assignedUserDoc = null;
      if (body.assignedUser && String(body.assignedUser).trim() !== '') {
        assignedUserDoc = await ensureUserExists(body.assignedUser);
      }

      const task = new Task({
        name: body.name,
        description: body.description || '',
        deadline: body.deadline,
        completed: !!body.completed,
        assignedUser: assignedUserDoc ? String(assignedUserDoc._id) : '',
        assignedUserName: assignedUserDoc ? assignedUserDoc.name : (body.assignedUserName || 'unassigned'),
        dateCreated: new Date()
      });

      const saved = await task.save();

      // Two-way: if assigned & not completed -> add to user's pendingTasks
      if (saved.assignedUser && !saved.completed) {
        await User.findByIdAndUpdate(
          saved.assignedUser,
          { $addToSet: { pendingTasks: saved._id } }
        );
      }

      return res.status(201).json({ message: 'Task created successfully', data: saved });
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ message: err.message, data: {} });
      }
      if (err.name === 'ValidationError') {
        return res.status(400).json({ message: 'Validation error', data: err });
      }
      return res.status(500).json({ message: 'Error creating task', data: err });
    }
  });

  // ---------- GET /api/tasks/:id ----------
  taskRoute.get(async function (req, res) {
    try {
      const select = parseJSON(req.query.select, 'select') || { __v: 0 };
      const task = await Task.findById(req.params.id).select(select).exec();
      if (!task) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }
      return res.status(200).json({ message: 'OK', data: task });
    } catch (err) {
      if (isCastError(err)) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }
      const status = err.status || 500;
      return res.status(status).json({ message: err.message || 'Error getting task', data: {} });
    }
  });

  // ---------- PUT /api/tasks/:id ----------
  // Replace entire task; name and deadline are required.
  taskRoute.put(async function (req, res) {
    try {
      const task = await Task.findById(req.params.id).exec();
      if (!task) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }

      const body = req.body || {};
      if (!body.name || !body.deadline) {
        return res.status(400).json({ message: 'name and deadline are required for PUT', data: {} });
      }

      // validate assignedUser if provided (non-empty string)
      let assignedUserDoc = null;
      let nextAssignedUser = '';
      let nextAssignedUserName = 'unassigned';
      if (body.assignedUser && String(body.assignedUser).trim() !== '') {
        assignedUserDoc = await ensureUserExists(body.assignedUser);
        nextAssignedUser = String(assignedUserDoc._id);
        nextAssignedUserName = assignedUserDoc.name;
      }

      const prevAssigned  = task.assignedUser ? String(task.assignedUser) : '';
      const prevCompleted = !!task.completed;

      // Replace fields (reasonable defaults)
      task.name = body.name;
      task.description = body.description || '';
      task.deadline = body.deadline;
      task.completed = !!body.completed;
      task.assignedUser = nextAssignedUser;
      task.assignedUserName = nextAssignedUserName;
      // keep original dateCreated

      const updated = await task.save();

      // Two-way maintenance:
      // 1) If previous user differs, pull from old user's pending
      if (prevAssigned && prevAssigned !== nextAssignedUser) {
        await User.findByIdAndUpdate(prevAssigned, { $pull: { pendingTasks: updated._id } });
      }

      // 2) If now has assigned user and not completed -> add to new user's pending
      if (nextAssignedUser && !updated.completed) {
        await User.findByIdAndUpdate(nextAssignedUser, { $addToSet: { pendingTasks: updated._id } });
      }

      // 3) Completion status change on same user
      if (prevAssigned === nextAssignedUser) {
        if (!prevCompleted && updated.completed && nextAssignedUser) {
          // became completed -> remove from pending
          await User.findByIdAndUpdate(nextAssignedUser, { $pull: { pendingTasks: updated._id } });
        } else if (prevCompleted && !updated.completed && nextAssignedUser) {
          // became uncompleted -> add to pending
          await User.findByIdAndUpdate(nextAssignedUser, { $addToSet: { pendingTasks: updated._id } });
        }
      }

      return res.status(200).json({ message: 'Task updated successfully', data: updated });
    } catch (err) {
      if (isCastError(err)) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }
      if (err.status === 400) {
        return res.status(400).json({ message: err.message, data: {} });
      }
      if (err.name === 'ValidationError') {
        return res.status(400).json({ message: 'Validation error', data: err });
      }
      return res.status(500).json({ message: 'Error updating task', data: err });
    }
  });

  // ---------- DELETE /api/tasks/:id ----------
  taskRoute.delete(async function (req, res) {
    try {
      const task = await Task.findById(req.params.id).exec();
      if (!task) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }

      const assignedUser = task.assignedUser ? String(task.assignedUser) : '';

      await Task.deleteOne({ _id: task._id });

      // Remove from user's pendingTasks if necessary
      if (assignedUser && !task.completed) {
        await User.findByIdAndUpdate(assignedUser, { $pull: { pendingTasks: task._id } });
      }

      // Return JSON per assignment's "always message+data"
      return res.status(200).json({ message: 'Task deleted successfully', data: {} });
    } catch (err) {
      if (isCastError(err)) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }
      return res.status(500).json({ message: 'Error deleting task', data: err });
    }
  });

  return router;
};