/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
  // Keep the existing API routes
  app.use('/api', require('./home.js')(router));      // existing JSON home
  app.use('/api/users', require('./users.js')());
  app.use('/api/tasks', require('./tasks.js')());

  // add a friendly homepage for root "/"
  app.get('/', (req, res) => {
    res.type('html').send(`<!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <title>Llama.io API Home</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, Arial, sans-serif;
            background-color: #f9fafb;
            color: #333;
            line-height: 1.6;
            margin: 2rem;
            }
            h1 {
            color: #222;
            margin-bottom: 0.5rem;
            }
            h2 {
            margin-top: 2rem;
            color: #444;
            }
            a {
            color: #0077cc;
            text-decoration: none;
            }
            a:hover {
            text-decoration: underline;
            }
            code {
            background: #f3f4f6;
            padding: 2px 5px;
            border-radius: 4px;
            }
            .card {
            background: white;
            padding: 1rem 1.5rem;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            margin-top: 1.5rem;
            }
        </style>
        </head>
        <body>
        <h1>✅ Llama.io API is running</h1>
        <p>Welcome to your API service! Below are some endpoints you can try:</p>

        <div class="card">
            <h2>Available Endpoints</h2>
            <ul>
            <li><a href="/api">GET /api</a> – API status message</li>
            <li><a href="/api/users">GET /api/users</a> – List all users</li>
            <li><a href="/api/tasks">GET /api/tasks</a> – List all tasks</li>
            </ul>
        </div>

        <div class="card">
            <h2>Query Examples</h2>
            <ul>
            <li><code>/api/tasks?where={"completed":true}</code> – Completed tasks</li>
            <li><code>/api/tasks?where={"assignedUser":{"$ne":""}}</code> – Assigned tasks</li>
            <li><code>/api/tasks?count=true</code> – Total number of tasks</li>
            <li><code>/api/users?sort={"name":1}</code> – Users sorted by name</li>
            <li><code>/api/users?skip=0&amp;limit=10</code> – Paginated users</li>
            </ul>
        </div>
        </body>
        </html>`);
  });
};