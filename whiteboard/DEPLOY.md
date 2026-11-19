# Deploying to PythonAnywhere

These steps put Whiteboard online at `https://USERNAME.pythonanywhere.com`, so it works on your
phone and the calendar link can be subscribed to. Replace `USERNAME` everywhere with your
PythonAnywhere username. It takes about 15 minutes.

The hosted site starts with an empty database. Your local cards stay on your laptop.

## 1. Before you start

- A free **Beginner** account at pythonanywhere.com.
- A GitHub token that can only read this repository, because the repo is private and free
  PythonAnywhere accounts can only reach GitHub over HTTPS:
  1. GitHub > Settings > Developer settings > Personal access tokens > **Fine-grained tokens** >
     Generate new token.
  2. Repository access: **Only select repositories** > `whiteboard-app`.
  3. Permissions > Repository permissions > **Contents: Read-only**. Nothing else.
  4. Copy the token. You paste it once in step 2 and never put it in a file.

## 2. Get the code (PythonAnywhere > Consoles > Bash)

```bash
git clone https://github.com/Wat-mat/whiteboard-app.git
```

When asked, the username is `Wat-mat` and the password is the token from step 1.

```bash
cd whiteboard-app
mkvirtualenv --python=/usr/bin/python3.13 whiteboard-venv
pip install -r requirements.txt
```

If Python 3.13 is not offered, use the newest version above it. The app needs 3.13 or later.

## 3. Settings (`.env`, which is never committed)

Make a secret key:

```bash
python -c "import secrets; print(secrets.token_urlsafe(50))"
```

Then create the settings file with `nano .env` and put in:

```
SECRET_KEY=paste-the-key-from-above
DEBUG=0
ALLOWED_HOSTS=USERNAME.pythonanywhere.com
CLIENT_IP_HEADER=HTTP_X_REAL_IP
# Only for Import schedule with images:
# ANTHROPIC_API_KEY=your-anthropic-key
```

Save with Ctrl+O, Enter, then Ctrl+X.

## 4. Database, login and static files

```bash
python manage.py migrate
python manage.py createsuperuser
python manage.py collectstatic --noinput
```

Use a strong password for `createsuperuser`. This is the login for the live site.

## 5. Web app (PythonAnywhere > Web)

1. **Add a new web app** > your `USERNAME.pythonanywhere.com` domain > **Manual configuration**
   (not the Django option) > Python 3.13.
2. **Virtualenv:** `/home/USERNAME/.virtualenvs/whiteboard-venv`
3. **Source code** and **Working directory:** `/home/USERNAME/whiteboard-app`
4. Open the **WSGI configuration file** link, delete everything in it, and paste:

   ```python
   import os
   import sys

   path = '/home/USERNAME/whiteboard-app'
   if path not in sys.path:
       sys.path.insert(0, path)

   os.environ['DJANGO_SETTINGS_MODULE'] = 'whiteboard.settings'

   from django.core.wsgi import get_wsgi_application
   application = get_wsgi_application()
   ```

   The settings read `.env` on their own, so nothing else is needed here.
5. **Static files:** URL `/static/`, Directory `/home/USERNAME/whiteboard-app/staticfiles`.
   Do **not** add a mapping for `/media/`: uploaded files are only served to their owner through the app.
6. **Security:** turn on **Force HTTPS**.
7. Press **Reload**, then open `https://USERNAME.pythonanywhere.com` and log in.

## 6. On your phone

- Open the site and log in, then use the browser's **Add to Home Screen** to get the app icon.
- **Menu > Calendar link** gives the private link to subscribe to in Apple or Google Calendar.

## Updating after new changes are pushed

```bash
cd ~/whiteboard-app
git pull
workon whiteboard-venv
pip install -r requirements.txt
python manage.py migrate
python manage.py collectstatic --noinput
```

Then press **Reload** on the Web tab. `git pull` asks for the GitHub token again.

## Good to know

- **Keep it running:** free web apps pause after 3 months unless you press
  **Run until 3 months from today** on the Web tab.
- **Image import:** free accounts can only reach an allow-list of outside sites. If importing an
  image says it could not reach the image reader, the Anthropic API is not reachable from a free
  account, and a paid account removes that limit. Calendar-file import and everything else work either way.
- **Backups:** your data is `db.sqlite3` plus the `media/` folder on PythonAnywhere. Download
  them now and then from the Files tab.
- **Keeping `requirements.txt` current** (on the laptop, after adding a package with `uv add`):
  `uv export --no-hashes --no-dev --no-emit-project --format requirements-txt -o requirements.txt`
