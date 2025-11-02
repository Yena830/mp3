// routes/tasks.js
const express = require('express');
const Task = require('../models/task');
const User = require('../models/user');

module.exports = function () {
  const router = express.Router();

  const tasksRoute = router.route('/');
  const taskRoute = router.route('/:id');

  // ---------- helpers ----------
  function parseJSON(q, field) {
    if (!q) return null;
    try {
      return JSON.parse(q);
    } catch {
      const err = new Error(`Invalid JSON in "${field}"`);
      err.status = 400;
      throw err;
    }
  }

  // ---------- GET /api/tasks ----------
  tasksRoute.get(async function (req, res) {
    try {
      const where = parseJSON(req.query.where, 'where') || {};

      // If asking for count, only apply "where" conditions.
      if (req.query.count === 'true') {
        const count = await Task.countDocuments(where);
        return res.status(200).json({ message: 'OK', data: count });
      }

      let query = Task.find(where);

      const sort = parseJSON(req.query.sort, 'sort');
      if (sort) query = query.sort(sort);

      const select = parseJSON(req.query.select, 'select');
      if (select) query = query.select(select);
      else query = query.select('-__v'); // default: hide __v

      if (req.query.skip) query = query.skip(parseInt(req.query.skip, 10));
      if (req.query.limit) query = query.limit(parseInt(req.query.limit, 10));
      else query = query.limit(100); // default limit for tasks

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
      const task = new Task(req.body);
      task.dateCreated = new Date();

      const savedTask = await task.save();

      // Two-way reference: when a task is assigned and not completed, add to user's pendingTasks
      if (savedTask.assignedUser && !savedTask.completed) {
        await User.findByIdAndUpdate(
          savedTask.assignedUser,
          { $addToSet: { pendingTasks: savedTask._id } },
          { new: false }
        );
      }

      return res.status(201).json({ message: 'Task created successfully', data: savedTask });
    } catch (err) {
      if (err.name === 'ValidationError') {
        return res.status(400).json({ message: 'Validation error', data: err });
      }
      return res.status(500).json({ message: 'Error creating task', data: err });
    }
  });

  // ---------- GET /api/tasks/:id ----------
  taskRoute.get(async function (req, res) {
    try {
      const task = await Task.findById(req.params.id).exec();
      if (!task) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }

      // Support ?select=... for the :id endpoint
      const select = parseJSON(req.query.select, 'select');
      if (select) {
        Object.keys(select).forEach((k) => {
          if (select[k] === 0) task[k] = undefined;
        });
        if (select.__v !== 1) task.__v = undefined;
      } else {
        task.__v = undefined;
      }

      return res.status(200).json({ message: 'OK', data: task });
    } catch (err) {
      return res.status(500).json({ message: 'Error getting task', data: err });
    }
  });

  // ---------- PUT /api/tasks/:id ----------
  taskRoute.put(async function (req, res) {
    try {
      const task = await Task.findById(req.params.id).exec();
      if (!task) {
        return res.status(404).json({ message: 'Task not found', data: {} });
      }

      // Snapshots for two-way updates
      const oldAssignedUser = task.assignedUser ? String(task.assignedUser) : '';
      const wasCompleted = !!task.completed;

      // Apply updates
      task.name = req.body.name ?? task.name;
      task.description = req.body.description ?? task.description;
      task.deadline = req.body.deadline ?? task.deadline;
      task.completed = (req.body.completed !== undefined) ? req.body.completed : task.completed;
      task.assignedUser = req.body.assignedUser ?? task.assignedUser;
      task.assignedUserName = req.body.assignedUserName ?? task.assignedUserName;

      const updatedTask = await task.save();

      // Two-way maintenance
      const newAssignedUser = updatedTask.assignedUser ? String(updatedTask.assignedUser) : '';
      const isCompleted = !!updatedTask.completed;

      // If user changed: pull from old, add to new (only if not completed)
      if (oldAssignedUser && oldAssignedUser !== newAssignedUser) {
        await User.findByIdAndUpdate(oldAssignedUser, { $pull: { pendingTasks: updatedTask._id } });
      }
      if (newAssignedUser && !isCompleted) {
        await User.findByIdAndUpdate(newAssignedUser, { $addToSet: { pendingTasks: updatedTask._id } });
      }

      // If completion status toggled: sync pendingTasks for the (new/current) user
      if (wasCompleted !== isCompleted && newAssignedUser) {
        if (isCompleted) {
          await User.findByIdAndUpdate(newAssignedUser, { $pull: { pendingTasks: updatedTask._id } });
        } else {
          await User.findByIdAndUpdate(newAssignedUser, { $addToSet: { pendingTasks: updatedTask._id } });
        }
      }

      return res.status(200).json({ message: 'Task updated successfully', data: updatedTask });
    } catch (err) {
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

      if (assignedUser) {
        await User.findByIdAndUpdate(assignedUser, { $pull: { pendingTasks: task._id } });
      }

      return res.status(200).json({ message: 'Task deleted successfully', data: {} });
    } catch (err) {
      return res.status(500).json({ message: 'Error deleting task', data: err });
    }
  });

  return router;
};