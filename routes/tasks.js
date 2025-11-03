// routes/tasks.js
const express = require('express');
const mongoose = require('mongoose');
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
  function isBadIdCast(err) {
    return err && err.name === 'CastError' && err.path === '_id';
  }
  async function ensureUserExists(userId, session) {
    if (!userId) return null;
    const str = String(userId);
    if (!mongoose.Types.ObjectId.isValid(str)) {
      const err = new Error('assignedUser must be a valid ObjectId');
      err.status = 400;
      throw err;
    }
    const u = await User.findById(str).select({ name: 1 }).session(session || null).exec();
    if (!u) {
      const err = new Error('assignedUser not found');
      err.status = 400;
      throw err;
    }
    return u;
  }

  // ---------- GET /api/tasks ----------
  tasksRoute.get(async (req, res) => {
    try {
      const where = parseJSON(req.query.where, 'where') || {};

      // count-only
      if (req.query.count === 'true') {
        const count = await Task.countDocuments(where);
        return res.status(200).json({ message: 'OK', data: count });
      }

      // list
      let query = Task.find(where);

      const sort   = parseJSON(req.query.sort, 'sort');
      const select = parseJSON(req.query.select, 'select');

      if (sort)   query = query.sort(sort);
      if (select) query = query.select(select);
      else        query = query.select('-__v'); // 默认隐藏 __v

      if (req.query.skip) {
        const n = parseInt(req.query.skip, 10);
        if (!Number.isNaN(n)) query = query.skip(n);
      }
      if (req.query.limit) {
        const n = parseInt(req.query.limit, 10);
        if (!Number.isNaN(n) && n > 0) query = query.limit(n);
      } else {
        query = query.limit(100); // 规范：tasks 默认 100
      }

      const tasks = await query.exec();
      return res.status(200).json({ message: 'OK', data: tasks });
    } catch (e) {
      const status = e.status || 500;
      const msg = e.status === 400 ? e.message : 'Error getting tasks';
      return res.status(status).json({ message: msg, data: {} });
    }
  });

  // ---------- POST /api/tasks ----------
  tasksRoute.post(async (req, res) => {
    const session = await Task.startSession();
    try {
      let savedTask;
      await session.withTransaction(async () => {
        const body = req.body || {};

        // parse & validate assigned object (if provided)
        let assignedUserDoc = null;
        let assignedUser = '';
        let assignedUserName = 'unassigned';
        if (body.assignedUser && String(body.assignedUser).trim() !== '') {
          assignedUserDoc = await ensureUserExists(body.assignedUser, session);
          assignedUser = String(assignedUserDoc._id);
          assignedUserName = assignedUserDoc.name; // force name from database
        }

        const task = new Task({
          name: body.name,
          description: body.description || '',
          deadline: body.deadline,      // let Schema required validation
          completed: !!body.completed,
          assignedUser,
          assignedUserName,
          dateCreated: new Date()
        });

        savedTask = await task.save({ session }); // trigger Schema Validation

        // two-way maintenance: if assigned and not completed → add to assignedUser's pendingTasks
        if (savedTask.assignedUser && !savedTask.completed) {
          await User.findByIdAndUpdate(
            savedTask.assignedUser,
            { $addToSet: { pendingTasks: savedTask._id } },
            { session }
          );
        }
      });

      return res.status(201).json({ message: 'Task created successfully', data: savedTask });
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ message: err.message, data: {} });
      }
      if (err.name === 'ValidationError') {
        // unified friendly prompt, do not leak underlying field details
        return res.status(400).json({ message: 'Invalid task data: name and deadline are required', data: {} });
      }
      return res.status(500).json({ message: 'Error creating task', data: {} });
    } finally {
      session.endSession();
    }
  });

  // ---------- GET /api/tasks/:id ----------
  taskRoute.get(async (req, res) => {
    try {
      const select = parseJSON(req.query.select, 'select') || { __v: 0 };
      const task = await Task.findById(req.params.id).select(select).exec();
      if (!task) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }
      return res.status(200).json({ message: 'OK', data: task });
    } catch (err) {
      if (isBadIdCast(err)) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }
      return res.status(500).json({ message: 'Error getting task', data: {} });
    }
  });

  // ---------- PUT /api/tasks/:id ----------
  // replace entire task; maintain two-way reference consistency with User in transaction
  taskRoute.put(async (req, res) => {
    const session = await Task.startSession();
    try {
      let updated;
      await session.withTransaction(async () => {
        const task = await Task.findById(req.params.id).session(session);
        if (!task) { res.status(404).json({ message: 'Task not found', data: {} }); return; }

        const body = req.body || {};


        let nextAssignedUser = '';
        let nextAssignedUserName = 'unassigned';
        if (body.assignedUser && String(body.assignedUser).trim() !== '') {
          const assignedUserDoc = await ensureUserExists(body.assignedUser, session);
          nextAssignedUser = String(assignedUserDoc._id);
          nextAssignedUserName = assignedUserDoc.name;
        }

        const prevAssigned  = task.assignedUser ? String(task.assignedUser) : '';
        const prevCompleted = !!task.completed;

        task.name = body.name;
        task.description = body.description || '';
        task.deadline = body.deadline;
        task.completed = !!body.completed;
        task.assignedUser = nextAssignedUser;
        task.assignedUserName = nextAssignedUserName;

        updated = await task.save({ session });

        if (prevAssigned && prevAssigned !== nextAssignedUser) {
          await User.findByIdAndUpdate(prevAssigned, { $pull: { pendingTasks: updated._id } }, { session });
        }
        if (nextAssignedUser && !updated.completed) {
          await User.findByIdAndUpdate(nextAssignedUser, { $addToSet: { pendingTasks: updated._id } }, { session });
        }
        if (prevAssigned === nextAssignedUser && nextAssignedUser) {
          if (!prevCompleted && updated.completed) {
            await User.findByIdAndUpdate(nextAssignedUser, { $pull: { pendingTasks: updated._id } }, { session });
          } else if (prevCompleted && !updated.completed) {
            await User.findByIdAndUpdate(nextAssignedUser, { $addToSet: { pendingTasks: updated._id } }, { session });
          }
        }
      });

      return res.status(200).json({ message: 'Task updated successfully', data: updated });
    } catch (err) {
      if (isBadIdCast(err)) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }
      if (err.status === 400) {
        return res.status(400).json({ message: err.message, data: {} });
      }
      if (err.name === 'ValidationError') {
        return res.status(400).json({ message: 'Invalid task data: name and deadline are required', data: {} });
      }
      return res.status(500).json({ message: 'Error updating task', data: {} });
    } finally {
      session.endSession();
    }
  });

  // ---------- DELETE /api/tasks/:id ----------
  taskRoute.delete(async (req, res) => {
    const session = await Task.startSession();
    try {
      await session.withTransaction(async () => {
        const task = await Task.findById(req.params.id).session(session);
        if (!task) { res.status(404).json({ message: 'Task not found', data: {} }); return; }

        const assignedUser = task.assignedUser ? String(task.assignedUser) : '';

        await Task.deleteOne({ _id: task._id }, { session });

        if (assignedUser && !task.completed) {
          await User.findByIdAndUpdate(assignedUser, { $pull: { pendingTasks: task._id } }, { session });
        }

        // 204 No Content
        res.status(204).send();
      });
    } catch (err) {
      if (isBadIdCast(err)) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }
      return res.status(500).json({ message: 'Error deleting task', data: {} });
    } finally {
      session.endSession();
    }
  });

  return router;
};