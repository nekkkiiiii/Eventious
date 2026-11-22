# Eventious: Event Management System

Keep track of upcoming events, get reminders before they happen, and track each event's needs (tables, chairs, tents, utensils, and more). Built with Node.js + Express, PostgreSQL, and plain HTML/CSS/JS.

## Requirements
- Node.js 18 or newer
- A PostgreSQL database (a free hosted one from Neon, Supabase, or Vercel works)

## Run locally
1. Install dependencies:
   ```
   npm install
   ```
2. Create your config file (skip if `.env` already exists):
   ```
   copy .env.example .env
   ```
   Then edit `.env`: set `DATABASE_URL` to your PostgreSQL connection string, and set `SESSION_SECRET` to a long random string.
3. Start the server:
   ```
   npm start
   ```
4. Open http://localhost:3000 and create an account.

On first start, the server creates its tables automatically. You can also run `schema.sql` yourself in your database's SQL editor.

## Deploy to Vercel
1. Push this repo to GitHub and import it in Vercel (no build settings needed; `vercel.json` handles them).
2. Create a PostgreSQL database (in Vercel: **Storage → Create Database → Neon**, connected to this project, adds `DATABASE_URL` for you; or copy the connection string from Neon/Supabase).
3. In **Settings → Environment Variables**, make sure these exist:
   - `DATABASE_URL`: the connection string (ends with `?sslmode=require`)
   - `SESSION_SECRET`: a long random string
4. Redeploy. The first account you register becomes the admin.

## Features
- Accounts with login (passwords hashed with bcrypt, sessions stored in PostgreSQL)
- Two roles: admin (manages everything) and client (manages own events)
- Create, edit, and delete events (date, time, venue, client, category, notes)
- Needs list per event with quantities and a "ready" checkbox
- Reminders in the notification bell, plus optional desktop alerts
- Dashboard, calendar view, and a combined needs summary for upcoming events

## Roles
- **Admin**: sees, edits, and deletes every event, and manages users from the **Users** tab (change roles, remove accounts).
- **Client**: sees, edits, and deletes only the events they created.

The first account registered becomes the admin; everyone after that signs up as a client. If a database has users but no admin, the oldest account is promoted automatically. Admins can promote other users from the Users tab.

### Event approval
Events created by clients start as **Awaiting approval**. An admin opens the event and clicks **Approve** or **Decline**, with an optional note (a note is required when declining). The client sees the decision and note on the event and in the notification bell. If a client edits an event after it was reviewed, it goes back to awaiting approval. Events created by admins are approved automatically. Declined events are left out of reminders and the needs summary.

## Project structure
```
server.js       Express server: auth + event + user API
db.js           PostgreSQL connection and automatic schema setup
schema.sql      Tables: users, events, event_needs, session
api/index.js    Vercel serverless entry point
vercel.json     Vercel config (static files from public/, /api/* to the server)
public/         Frontend (index.html, login.html, app.js, styles.css)
```

## API
All routes except register/login require you to be logged in.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/register` | Create account `{name, email, password}` |
| POST | `/api/login` | Log in `{email, password}` |
| POST | `/api/logout` | Log out |
| GET | `/api/me` | Current user |
| GET | `/api/events` | List events (all for admins, own for clients) |
| POST | `/api/events` | Create event |
| PUT | `/api/events/:id` | Update event (replaces its needs list) |
| PATCH | `/api/events/:id/needs/:needId` | Mark a need ready `{ready}` |
| POST | `/api/events/:id/review` | Approve/decline `{decision: "approved" or "declined", note}` (admin only) |
| DELETE | `/api/events/:id` | Delete event |
| GET | `/api/users` | List users (admin only) |
| PATCH | `/api/users/:id` | Change role `{role: "admin" or "client"}` (admin only) |
| DELETE | `/api/users/:id` | Remove a user and their events (admin only) |
