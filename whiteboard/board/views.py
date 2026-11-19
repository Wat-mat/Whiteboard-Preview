import json
import os
import secrets
from functools import wraps
from pathlib import Path

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import F, Max
from django.http import FileResponse, Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from . import layout
from .models import MAX_DEPTH, Area, Attachment, ImageReads, Link, Preferences, Project, Todo
from .schedule import ScheduleReadError, calendar_feed, read_ics, read_schedule_image

PROJECT_FIELDS = {'name', 'zone', 'status', 'x', 'y', 'collapsed', 'notes'}
TODO_FIELDS = {'text', 'done', 'due', 'x', 'y'}
LINK_FIELDS = {'label', 'url'}
AREA_FIELDS = {'name', 'x', 'y', 'w', 'h'}
PREFERENCE_FIELDS = {'confirm_deletes'}


def api_login_required(view):
    """Like login_required, but answers 401 JSON instead of redirecting."""
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return JsonResponse({'error': 'Login required.'}, status=401)
        return view(request, *args, **kwargs)
    return wrapped


def reject_constant(name):
    raise ValueError(f'{name} is not allowed')


def read_json(request):
    try:
        # NaN and Infinity are valid to Python's parser but not real JSON; they would break card positions.
        data = json.loads(request.body or b'{}', parse_constant=reject_constant)
    except ValueError:  # includes JSONDecodeError
        return None
    return data if isinstance(data, dict) else None


def bad_request(message):
    return JsonResponse({'error': message}, status=400)


def save_or_error(obj):
    try:
        obj.full_clean()
    except ValidationError as e:
        return bad_request('; '.join(e.messages))
    obj.save()
    return None


def apply_fields(obj, data, allowed):
    """Copy allowed JSON fields onto obj and validate. Returns an error response or None."""
    if data is None:
        return bad_request('Expected a JSON object.')
    unknown = set(data) - allowed
    if unknown:
        return bad_request(f'Unknown fields: {", ".join(sorted(unknown))}')
    for field, value in data.items():
        if field == 'due' and not value:
            value = None
        setattr(obj, field, value)
    return save_or_error(obj)


MAX_ID = 2**63 - 1  # largest id the database can store; bigger numbers would crash the lookup


def is_id(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= MAX_ID


def owned_project(request, pk):
    return get_object_or_404(Project, pk=pk, owner=request.user)


def next_list_order(project):
    """Next free slot in a project's top-level to-do list (shared by to-dos and sub-cards)."""
    orders = [
        project.todos.filter(parent=None).aggregate(m=Max('order'))['m'],
        project.children.aggregate(m=Max('list_order'))['m'],
    ]
    return max((o for o in orders if o is not None), default=-1) + 1


def todo_json(t):
    return {'id': t.id, 'parent': t.parent_id, 'text': t.text, 'done': t.done,
            'due': t.due.isoformat() if t.due else None, 'order': t.order, 'x': t.x, 'y': t.y}


def link_json(link):
    return {'id': link.id, 'label': link.label, 'url': link.url}


def area_json(a):
    return {'id': a.id, 'name': a.name, 'x': a.x, 'y': a.y, 'w': a.w, 'h': a.h}


def attachment_json(a):
    return {'id': a.id, 'name': a.original_name, 'kind': a.kind, 'size': a.size,
            'url': reverse('attachment-file', args=[a.id])}


def project_json(p):
    return {
        'id': p.id, 'parent': p.parent_id, 'name': p.name, 'zone': p.zone, 'status': p.status,
        'x': p.x, 'y': p.y, 'collapsed': p.collapsed, 'list_order': p.list_order, 'notes': p.notes,
        'todos': [todo_json(t) for t in p.todos.all()],
        'links': [link_json(link) for link in p.links.all()],
        'areas': [area_json(a) for a in p.areas.all()],
        'attachments': [attachment_json(a) for a in p.attachments.all()],
    }


STATIC_DIR = Path(__file__).resolve().parent / 'static' / 'board'
# Load order matters: each file uses functions from the ones before it.
SCRIPTS = ['common.js', 'ui.js', 'surface.js', 'project.js', 'mini.js', 'board.js', 'search.js', 'import.js', 'keys.js']


def asset_version():
    """Newest modification time of the board's static files, so browsers fetch fresh copies after edits."""
    return max((f.stat().st_mtime_ns for f in STATIC_DIR.iterdir()), default=0)


@login_required
def board(request):
    return render(request, 'board/board.html', {
        'scripts': SCRIPTS,
        'asset_version': asset_version(),
        'prefs': preferences_json(Preferences.for_user(request.user)),
        'layout': {
            'zones': layout.ZONES,
            'card': {'w': layout.CARD_W, 'h': layout.CARD_H, 'gapX': layout.GAP_X, 'gapY': layout.GAP_Y,
                     'padX': layout.PAD_X, 'padY': layout.PAD_Y},
        },
    })


def preferences_json(prefs):
    return {'confirm_deletes': prefs.confirm_deletes}


@api_login_required
@require_http_methods(['GET', 'PATCH'])
def preferences(request):
    prefs = Preferences.for_user(request.user)
    if request.method == 'PATCH':
        if error := apply_fields(prefs, read_json(request), PREFERENCE_FIELDS):
            return error
    return JsonResponse(preferences_json(prefs))


# ---------- projects ----------

@api_login_required
@require_http_methods(['GET', 'POST'])
def projects(request):
    if request.method == 'GET':
        qs = request.user.projects.prefetch_related('todos', 'links', 'areas', 'attachments')
        return JsonResponse({'projects': [project_json(p) for p in qs]})

    data = read_json(request)
    if data is None:
        return bad_request('Expected a JSON object.')
    parent_id = data.get('parent')
    if parent_id is not None and not is_id(parent_id):
        return bad_request('parent must be a project id.')
    parent = owned_project(request, parent_id) if parent_id is not None else None
    project = Project(
        owner=request.user, parent=parent, name=str(data.get('name', '')).strip(),
        zone=data.get('zone', Project.Zone.OTHER), x=data.get('x', 0), y=data.get('y', 0),
        list_order=next_list_order(parent) if parent else 0,
    )
    if error := save_or_error(project):
        return error
    return JsonResponse(project_json(project), status=201)


@api_login_required
@require_http_methods(['PATCH', 'DELETE'])
def project_detail(request, pk):
    project = owned_project(request, pk)
    if request.method == 'DELETE':
        project.delete()
        return HttpResponse(status=204)
    if error := apply_fields(project, read_json(request), PROJECT_FIELDS):
        return error
    return JsonResponse(project_json(project))


@api_login_required
@require_http_methods(['POST'])
def reorder(request, pk):
    """Set the order of one level of a project's to-do list.

    Body: {"parent": <todo id or null>, "items": [{"type": "todo"|"card", "id": n}, ...]}
    The top level (parent null) mixes to-dos and sub-cards; deeper levels hold only to-dos.
    """
    project = owned_project(request, pk)
    data = read_json(request)
    if data is None or not isinstance(data.get('items'), list):
        return bad_request('Expected {"parent": ..., "items": [...]}.')
    parent_id = data.get('parent')
    if parent_id is not None and not is_id(parent_id):
        return bad_request('parent must be a to-do id.')
    expected = {('todo', t_id) for t_id in project.todos.filter(parent_id=parent_id).values_list('id', flat=True)}
    if parent_id is None:
        expected |= {('card', c_id) for c_id in project.children.values_list('id', flat=True)}
    given = [(i.get('type'), i.get('id')) for i in data['items'] if isinstance(i, dict) and is_id(i.get('id'))]
    if len(given) != len(data['items']) or len(given) != len(expected) or set(given) != expected:
        return bad_request('Items must list every item at that level exactly once.')
    with transaction.atomic():
        for index, (kind, item_id) in enumerate(given):
            if kind == 'todo':
                Todo.objects.filter(pk=item_id).update(order=index)
            else:
                Project.objects.filter(pk=item_id).update(list_order=index)
    return HttpResponse(status=204)


# ---------- to-dos ----------

@api_login_required
@require_http_methods(['POST'])
def todos(request, pk):
    project = owned_project(request, pk)
    data = read_json(request)
    if data is None:
        return bad_request('Expected a JSON object.')
    parent = None
    if data.get('parent') is not None:
        if not is_id(data['parent']):
            return bad_request('parent must be a to-do id.')
        parent = get_object_or_404(Todo, pk=data['parent'], project=project)
    if parent:
        last = parent.subtasks.aggregate(m=Max('order'))['m']
        order = 0 if last is None else last + 1
    else:
        order = next_list_order(project)
    todo = Todo(project=project, parent=parent, text=str(data.get('text', '')).strip(),
                due=data.get('due') or None, order=order)
    if error := save_or_error(todo):
        return error
    return JsonResponse(todo_json(todo), status=201)


@api_login_required
@require_http_methods(['PATCH', 'DELETE'])
def todo_detail(request, pk):
    todo = get_object_or_404(Todo, pk=pk, project__owner=request.user)
    if request.method == 'DELETE':
        todo.delete()
        return HttpResponse(status=204)
    if error := apply_fields(todo, read_json(request), TODO_FIELDS):
        return error
    return JsonResponse(todo_json(todo))


# ---------- moving between levels ----------

def subtree_height(node, children):
    """Levels in node's subtree, counting node itself. children(node) lists the next level down."""
    return 1 + max((subtree_height(c, children) for c in children(node)), default=0)


def is_inside(node, ancestor):
    """True when node is ancestor or sits somewhere below it."""
    while node is not None:
        if node.pk == ancestor.pk:
            return True
        node = node.parent
    return False


def make_room_after(project, parent, after):
    """Order value for an item placed right after `after` in one level of a project's list.

    The level is the to-dos under `parent` (plus sub-cards when parent is None). Items after the
    spot shift down by one. after=None appends to the end. Raises LookupError for a bad `after`.
    """
    todos = project.todos.filter(parent=parent)
    cards = project.children.all() if parent is None else Project.objects.none()
    if after is None:
        if parent is None:
            return next_list_order(project)
        last = todos.aggregate(m=Max('order'))['m']
        return 0 if last is None else last + 1
    if after.get('type') == 'todo':
        anchor = todos.filter(pk=after.get('id')).values_list('order', flat=True).first()
    elif after.get('type') == 'card':
        anchor = cards.filter(pk=after.get('id')).values_list('list_order', flat=True).first()
    else:
        anchor = None
    if anchor is None:
        raise LookupError
    todos.filter(order__gt=anchor).update(order=F('order') + 1)
    cards.filter(list_order__gt=anchor).update(list_order=F('list_order') + 1)
    return anchor + 1


@api_login_required
@require_http_methods(['POST'])
def todo_move(request, pk):
    """Re-nest a to-do inside its project. Body: {"parent": <to-do id or null>, "after": {"type", "id"} or null}."""
    todo = get_object_or_404(Todo, pk=pk, project__owner=request.user)
    data = read_json(request)
    if data is None:
        return bad_request('Expected a JSON object.')
    parent_id, after = data.get('parent'), data.get('after')
    if parent_id is not None and not is_id(parent_id):
        return bad_request('parent must be a to-do id.')
    if after is not None and not (isinstance(after, dict) and is_id(after.get('id'))):
        return bad_request('after must be {"type": ..., "id": ...} or null.')
    parent = get_object_or_404(Todo, pk=parent_id, project=todo.project) if parent_id is not None else None
    if parent is not None and is_inside(parent, todo):
        return bad_request('A task cannot go inside itself.')
    if (parent.depth() if parent else 0) + subtree_height(todo, lambda t: t.subtasks.all()) > MAX_DEPTH:
        return bad_request(f'Tasks can only nest {MAX_DEPTH} levels deep.')
    with transaction.atomic():
        try:
            order = make_room_after(todo.project, parent, after)
        except LookupError:
            return bad_request('after must be an item in that list.')
        todo.parent, todo.order = parent, order
        todo.save(update_fields=['parent', 'order'])
    return JsonResponse(todo_json(todo))


@api_login_required
@require_http_methods(['POST'])
def todo_to_card(request, pk):
    """Turn a to-do into a sub-card in the same spot of the list. Its sub-tasks become the card's to-dos.

    A due date is kept as the card's first to-do, since cards have no date of their own.
    Body: {"x": n, "y": n} for the card's spot on the board.
    """
    todo = get_object_or_404(Todo, pk=pk, project__owner=request.user)
    project = todo.project
    if project.depth() >= MAX_DEPTH:
        return bad_request(f'Level {MAX_DEPTH} cards cannot hold sub-cards.')
    data = read_json(request)
    if data is None:
        return bad_request('Expected a JSON object.')
    with transaction.atomic():
        card = Project(
            owner=request.user, parent=project, name=todo.text[:200], x=data.get('x', 0), y=data.get('y', 0),
            status=Project.Status.DONE if todo.done else Project.Status.NOT_STARTED, list_order=todo.order,
        )
        if error := save_or_error(card):
            return error
        first = 0
        if todo.due:
            Todo.objects.create(project=card, text=todo.text, due=todo.due, done=todo.done, order=0)
            first = 1
        moving, level = [], list(todo.subtasks.all())
        for i, child in enumerate(level):
            child.parent, child.order = None, first + i
        while level:
            moving.extend(level)
            level = [t for parent in level for t in parent.subtasks.all()]
        for t in moving:
            t.project = card
        Todo.objects.bulk_update(moving, ['project', 'parent', 'order'])
        todo.delete()  # its sub-tasks were detached above, so the delete no longer cascades to them
    card = Project.objects.prefetch_related('todos', 'links', 'areas', 'attachments').get(pk=card.pk)
    return JsonResponse(project_json(card), status=201)


@api_login_required
@require_http_methods(['POST'])
def project_move(request, pk):
    """Move a card onto another card's board, or back to the main board.

    Body: {"parent": <card id or null>, "x": n, "y": n, "zone": <zone, main board only>}.
    """
    project = owned_project(request, pk)
    data = read_json(request)
    if data is None:
        return bad_request('Expected a JSON object.')
    parent_id = data.get('parent')
    if parent_id is not None and not is_id(parent_id):
        return bad_request('parent must be a card id.')
    parent = owned_project(request, parent_id) if parent_id is not None else None
    if parent is not None and is_inside(parent, project):
        return bad_request('A card cannot go inside itself.')
    if (parent.depth() if parent else 0) + subtree_height(project, lambda p: p.children.all()) > MAX_DEPTH:
        return bad_request(f'Cards can only nest {MAX_DEPTH} levels deep.')
    project.parent = parent
    project.x, project.y = data.get('x', project.x), data.get('y', project.y)
    if parent is None:
        project.zone = data.get('zone', project.zone)
    else:
        project.list_order = next_list_order(parent)
    if error := save_or_error(project):
        return error
    return JsonResponse(project_json(project))


# ---------- links and areas ----------

@api_login_required
@require_http_methods(['POST'])
def links(request, pk):
    link = Link(project=owned_project(request, pk))
    if error := apply_fields(link, read_json(request), LINK_FIELDS):
        return error
    return JsonResponse(link_json(link), status=201)


@api_login_required
@require_http_methods(['PATCH', 'DELETE'])
def link_detail(request, pk):
    link = get_object_or_404(Link, pk=pk, project__owner=request.user)
    if request.method == 'DELETE':
        link.delete()
        return HttpResponse(status=204)
    if error := apply_fields(link, read_json(request), LINK_FIELDS):
        return error
    return JsonResponse(link_json(link))


@api_login_required
@require_http_methods(['POST'])
def areas(request, pk):
    area = Area(project=owned_project(request, pk))
    if error := apply_fields(area, read_json(request), AREA_FIELDS):
        return error
    return JsonResponse(area_json(area), status=201)


@api_login_required
@require_http_methods(['PATCH', 'DELETE'])
def area_detail(request, pk):
    area = get_object_or_404(Area, pk=pk, project__owner=request.user)
    if request.method == 'DELETE':
        area.delete()
        return HttpResponse(status=204)
    if error := apply_fields(area, read_json(request), AREA_FIELDS):
        return error
    return JsonResponse(area_json(area))


# ---------- attachments ----------

# (first bytes, kind, content type, stored extension). The type comes from the file's
# contents, never from its name or the browser's claimed type.
SIGNATURES = [
    (b'%PDF-', Attachment.Kind.PDF, 'application/pdf', '.pdf'),
    (b'\x89PNG\r\n\x1a\n', Attachment.Kind.IMAGE, 'image/png', '.png'),
    (b'\xff\xd8\xff', Attachment.Kind.IMAGE, 'image/jpeg', '.jpg'),
    (b'GIF87a', Attachment.Kind.IMAGE, 'image/gif', '.gif'),
    (b'GIF89a', Attachment.Kind.IMAGE, 'image/gif', '.gif'),
]


def sniff(upload):
    head = upload.read(16)
    upload.seek(0)
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return Attachment.Kind.IMAGE, 'image/webp', '.webp'
    for magic, kind, content_type, ext in SIGNATURES:
        if head.startswith(magic):
            return kind, content_type, ext
    return None


@api_login_required
@require_http_methods(['POST'])
def attachments(request, pk):
    project = owned_project(request, pk)
    upload = request.FILES.get('file')
    if getattr(request, 'upload_too_large', False) or (upload is not None and upload.size > settings.MAX_UPLOAD_BYTES):
        return bad_request(f'Files can be at most {settings.MAX_UPLOAD_BYTES // (1024 * 1024)} MB.')
    if upload is None:
        return bad_request('Choose a file to upload.')
    detected = sniff(upload)
    if detected is None:
        return bad_request('Only PDF, PNG, JPEG, GIF and WebP files are allowed.')
    kind, content_type, ext = detected
    original_name = Path(upload.name).name[:255] or f'file{ext}'
    upload.name = f'upload{ext}'  # stored name gets a random stem and the detected extension
    attachment = Attachment.objects.create(
        project=project, file=upload, original_name=original_name,
        kind=kind, content_type=content_type, size=upload.size,
    )
    return JsonResponse(attachment_json(attachment), status=201)


@api_login_required
@require_http_methods(['DELETE'])
def attachment_detail(request, pk):
    get_object_or_404(Attachment, pk=pk, project__owner=request.user).delete()
    return HttpResponse(status=204)


@login_required
def attachment_file(request, pk):
    """Serve an upload to its owner only; uploads are never exposed under a public URL."""
    attachment = get_object_or_404(Attachment, pk=pk, project__owner=request.user)
    response = FileResponse(attachment.file.open('rb'), content_type=attachment.content_type,
                            filename=attachment.original_name)
    response['Cache-Control'] = 'private, max-age=86400'
    return response


# ---------- schedule import and calendar feed ----------

IMAGE_READS_PER_DAY = 30  # caps what one account can spend on the image reader
ICS_MAX_BYTES = 2 * 1024 * 1024


def reserve_image_read(user):
    """Counts one image read for today and returns today's total (one atomic UPDATE)."""
    today = timezone.localdate()
    ImageReads.objects.filter(day__lt=today).delete()  # only today's counts are needed
    ImageReads.objects.get_or_create(user=user, day=today)
    ImageReads.objects.filter(user=user, day=today).update(count=F('count') + 1)
    return ImageReads.objects.values_list('count', flat=True).get(user=user, day=today)


def is_calendar_file(upload):
    head = upload.read(64)
    upload.seek(0)
    return head.removeprefix(b'\xef\xbb\xbf').lstrip().upper().startswith(b'BEGIN:VCALENDAR')


@api_login_required
@require_http_methods(['POST'])
def schedule_read(request):
    """Lists the items in an uploaded schedule image or calendar file, for the user to review.

    Nothing is saved here; the page adds whichever items the user keeps.
    """
    upload = request.FILES.get('file')
    if getattr(request, 'upload_too_large', False):
        return bad_request(f'Files can be at most {settings.MAX_UPLOAD_BYTES // (1024 * 1024)} MB.')
    if upload is None:
        return bad_request('Choose a file to read.')

    if is_calendar_file(upload):
        if upload.size > ICS_MAX_BYTES:
            return bad_request('Calendar files can be at most 2 MB.')
        try:
            return JsonResponse({'source': 'calendar', 'items': read_ics(upload.read())})
        except ScheduleReadError as err:
            return bad_request(str(err))

    detected = sniff(upload)
    if detected is None or detected[0] != Attachment.Kind.IMAGE:
        return bad_request('Choose a photo or screenshot (PNG, JPEG, GIF, WebP) or a calendar file (.ics).')
    if not os.environ.get('ANTHROPIC_API_KEY'):
        return JsonResponse({'error': 'Reading images needs an Anthropic API key. Add ANTHROPIC_API_KEY to the .env file.'},
                            status=503)
    if reserve_image_read(request.user) > IMAGE_READS_PER_DAY:
        return JsonResponse({'error': f'That is {IMAGE_READS_PER_DAY} images today, the daily limit. Try again tomorrow.'},
                            status=429)
    try:
        items = read_schedule_image(upload)
    except ScheduleReadError as err:
        return JsonResponse({'error': str(err)}, status=502)
    return JsonResponse({'source': 'image', 'items': items})


def calendar_url(request, prefs):
    return request.build_absolute_uri(reverse('calendar-feed', args=[prefs.calendar_token]))


@api_login_required
@require_http_methods(['GET', 'POST'])
def calendar_link(request):
    """GET: the private calendar link, made on first use. POST: a new link; the old one stops working."""
    prefs = Preferences.for_user(request.user)
    if request.method == 'POST' or not prefs.calendar_token:
        prefs.calendar_token = secrets.token_urlsafe(32)
        prefs.save(update_fields=['calendar_token'])
    return JsonResponse({'url': calendar_url(request, prefs)})


@require_http_methods(['GET', 'HEAD'])
def calendar_feed_view(request, token):
    """The user's dated to-dos for calendar apps.

    No login on purpose: Apple and Google Calendar cannot log in, so the long random token in the
    link is what grants access. It only exposes to-do titles, dates and card names.
    """
    prefs = Preferences.objects.filter(calendar_token=token).select_related('user').first()
    if prefs is None or not token:
        raise Http404
    response = HttpResponse(calendar_feed(prefs.user, request.get_host()), content_type='text/calendar; charset=utf-8')
    response['Content-Disposition'] = 'inline; filename="whiteboard.ics"'
    response['Cache-Control'] = 'private, max-age=300'
    return response
