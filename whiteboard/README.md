# Whiteboard

A personal project manager that works like a whiteboard. Every project, trip, class, and
loose task is a card on one big board you can pan and zoom. Click a card to open its own page
with a to-do list, files, links, and notes. A "This Week" strip across the top shows what is
due soon, color-coded by how close the date is.

Built with Django and plain JavaScript. No front-end framework and no build step.

![The board, with cards grouped into Projects, Trips, School, Other Tasks, and Done](docs/screenshots/board.png)

![A project page with to-dos, attachments, links, notes, and a board of nested cards](docs/screenshots/project.png)

The screenshots use the built-in demo data, which is generic and loads with one command.

## Features

- **One board for everything.** Cards sit in zones (Projects, Trips, School, Other Tasks, Done).
  Drag cards around, zoom in and out, or press `F` to fit the board to the screen. A list view
  is also available.
- **Cards inside cards.** A card can hold sub-cards up to three levels deep, and each level has
  its own board.
- **To-dos with sub-tasks.** Due dates, check-offs, drag to reorder, and `Tab` / `Shift+Tab` to
  indent. Any to-do can be turned into its own card.
- **This Week strip.** Upcoming due dates across every card, red when close and amber when a
  couple of weeks out.
- **Project pages.** Each card has to-dos, file uploads (PDFs and images), links, free-text
  notes, and its own sticky-note board.
- **Search and keyboard shortcuts.** Press `/` to search, `N` for a new card, `T` for a new
  to-do, and `?` for the full list.
- **Calendar feed.** Your open, dated to-dos are published as a private `.ics` link that Apple
  Calendar or Google Calendar can subscribe to.
- **Import dates.** Pull dated items from a calendar file (`.ics`), or from a photo or
  screenshot of a schedule. The photo import is optional and uses the Anthropic API.
- **Works on a phone.** It has a web app manifest and icons, so it can be added to a phone's
  home screen.

## Security notes

- Sign-in is required for every page. Each user only sees their own cards and files.
- Login attempts are limited to 5 per 15 minutes, counted before the password is checked so
  parallel requests cannot get around the limit.
- Uploads are size-checked while they stream in, and record IDs in URLs are range-checked.
- With debug off, the app refuses to start unless a real `SECRET_KEY` is set in `.env`.
- Secrets live in `.env`, which is git-ignored. `.env.example` shows what to set.

## Run it locally

You need Python 3.13 or newer and [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/Wat-mat/whiteboard-app.git
cd whiteboard-app
uv sync
cp .env.example .env              # local settings; debug is on in the example
uv run manage.py migrate
uv run manage.py createsuperuser  # your login
uv run manage.py load_demo        # optional: fill the board with example cards
uv run manage.py runserver
```

Open http://127.0.0.1:8000 and sign in. `uv run manage.py clear_demo` removes the example
cards and leaves your own.

To use the photo schedule import, add an `ANTHROPIC_API_KEY` to `.env`. Everything else works
without it.

## Tests

```bash
uv run manage.py test
```

There are 80 tests covering the API, per-user access rules, nesting, the demo data, login
limits, and the calendar feed.

## Deploying

[DEPLOY.md](DEPLOY.md) walks through hosting it on PythonAnywhere's free plan.

## Project layout

```
board/                 the app
  models.py            projects (cards), to-dos, links, attachments, preferences
  views.py             JSON API and page views
  schedule.py          calendar-file and photo import, and the .ics feed
  security.py          login throttling and upload guard
  static/board/        vanilla JavaScript modules and CSS
  tests.py             test suite
whiteboard/            Django project settings and URLs
```

## License

[MIT](LICENSE)
