# TaskBoard

A minimal task manager app built to learn the Vercel + Render + Postgres stack.

```
server/    Express API + DB schema
frontend/  Static React-style frontend (plain HTML/JS)
```

## Stack

- **Frontend**: Static HTML/CSS/JS → hosted on Vercel
- **Backend**: Express (Node.js) → hosted on Render
- **Database**: PostgreSQL → hosted on Render

## Steps

1. ✅ Project structure + DB schema
2. [ ] Express API (CRUD endpoints)
3. [ ] Frontend UI
4. [ ] Deploy to Render + Vercel

## Local development

```bash
cd server && npm install
DATABASE_URL=postgres://localhost/taskboard npm run db:setup
DATABASE_URL=postgres://localhost/taskboard npm start
# frontend: open frontend/index.html in browser
```
