import base64
import io
import os
import shutil
import struct
import tempfile
import time
import zlib
from datetime import date, timedelta
from unittest.mock import patch
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import CommandError, call_command
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from PIL import Image

from .layout import ZONES
from .schedule import ScheduleReadError, clean_items, prepare_image, read_ics
from .models import Attachment, LoginAttempts, Preferences, Project, Todo

User = get_user_model()


def inside(region, project):
    z = ZONES[region]
    return z['x'] <= project.x < z['x'] + z['w'] and z['y'] <= project.y < z['y'] + z['h']


class AuthTests(TestCase):
    def test_board_requires_login(self):
        response = self.client.get(reverse('board'))
        self.assertRedirects(response, f"{reverse('login')}?next=/")

    def test_board_loads_when_logged_in(self):
        user = User.objects.create_user('me', password='pw-test-123')
        self.client.force_login(user)
        self.assertEqual(self.client.get(reverse('board')).status_code, 200)


class ProjectApiTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user('me', password='pw-test-123')
        self.other = User.objects.create_user('other', password='pw-test-123')
        self.mine = Project.objects.create(owner=self.me, name='Mine', zone='projects')
        Todo.objects.create(project=self.mine, text='Step', due='2026-10-20')
        self.theirs = Project.objects.create(owner=self.other, name='Theirs', zone='trips')
        self.client.force_login(self.me)

    def patch(self, project, data):
        return self.client.patch(reverse('api-project', args=[project.pk]), data, content_type='application/json')

    def test_api_requires_login(self):
        self.client.logout()
        self.assertEqual(self.client.get(reverse('api-projects')).status_code, 401)
        self.assertEqual(self.patch(self.mine, {'x': 5}).status_code, 401)

    def test_list_only_returns_own_projects(self):
        data = self.client.get(reverse('api-projects')).json()
        self.assertEqual([p['name'] for p in data['projects']], ['Mine'])
        self.assertEqual(data['projects'][0]['todos'][0]['due'], '2026-10-20')

    def test_create_project(self):
        response = self.client.post(reverse('api-projects'), {'name': ' New ', 'zone': 'school', 'x': 10, 'y': 20},
                                    content_type='application/json')
        self.assertEqual(response.status_code, 201)
        project = Project.objects.get(pk=response.json()['id'])
        self.assertEqual((project.owner, project.name, project.zone), (self.me, 'New', 'school'))

    def test_create_rejects_blank_name_and_bad_zone(self):
        for body in [{'name': '', 'zone': 'school'}, {'name': 'X', 'zone': 'nowhere'}]:
            response = self.client.post(reverse('api-projects'), body, content_type='application/json')
            self.assertEqual(response.status_code, 400, body)

    def test_patch_moves_card(self):
        response = self.patch(self.mine, {'x': 300.5, 'y': 700, 'zone': 'school', 'status': 'done'})
        self.assertEqual(response.status_code, 200)
        self.mine.refresh_from_db()
        self.assertEqual((self.mine.x, self.mine.y, self.mine.zone, self.mine.status), (300.5, 700, 'school', 'done'))

    def test_patch_rejects_unknown_and_invalid_fields(self):
        self.assertEqual(self.patch(self.mine, {'owner': self.other.pk}).status_code, 400)
        self.assertEqual(self.patch(self.mine, {'status': 'lost'}).status_code, 400)
        self.assertEqual(self.patch(self.mine, {'x': 'far'}).status_code, 400)

    def test_cannot_patch_other_users_project(self):
        self.assertEqual(self.patch(self.theirs, {'x': 1}).status_code, 404)


class DemoDataTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_superuser('me', password='pw-test-123')

    def test_load_demo_creates_projects_for_superuser(self):
        call_command('load_demo')
        projects = Project.objects.filter(owner=self.me, is_demo=True, parent=None)
        self.assertEqual(projects.count(), 14)
        math = projects.get(name='Math 101')
        self.assertEqual([t.text for t in math.todos.all()][0], 'Quiz 1')
        self.assertEqual(math.todos.count(), 5)

    def test_done_projects_start_in_done_area(self):
        call_command('load_demo')
        for name in ['Antique Tool Restoration', 'Lake Cabin Weekend']:
            project = Project.objects.get(name=name)
            self.assertEqual(project.status, 'done')
            self.assertTrue(inside('done', project), name)

    def test_active_projects_start_in_their_zone(self):
        call_command('load_demo')
        for project in Project.objects.filter(parent=None).exclude(status='done'):
            self.assertTrue(inside(project.zone, project), project.name)

    def test_demo_includes_three_level_nesting(self):
        call_command('load_demo')
        parts = Project.objects.get(name='Parts')
        self.assertEqual(parts.depth(), 3)
        self.assertEqual(parts.parent.name, 'Exhaust')
        warning_light = Todo.objects.get(text='Diagnose the engine warning light')
        self.assertEqual([t.text for t in warning_light.subtasks.all()], ['Test the purge valve'])

    def test_load_demo_twice_is_refused(self):
        call_command('load_demo')
        with self.assertRaises(CommandError):
            call_command('load_demo')

    def test_clear_demo_keeps_real_projects(self):
        call_command('load_demo')
        Project.objects.create(owner=self.me, name='Real one')
        call_command('clear_demo')
        self.assertEqual(list(Project.objects.values_list('name', flat=True)), ['Real one'])
        self.assertFalse(Todo.objects.exists())


class NestingApiTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user('me', password='pw-test-123')
        self.other = User.objects.create_user('other', password='pw-test-123')
        self.top = Project.objects.create(owner=self.me, name='Top', zone='projects')
        self.client.force_login(self.me)

    def post(self, url, data):
        return self.client.post(url, data, content_type='application/json')

    def add_card(self, parent, name='Child'):
        return self.post(reverse('api-projects'), {'name': name, 'parent': parent.pk, 'x': 0, 'y': 0})

    def add_todo(self, project, text='Task', parent=None):
        return self.post(reverse('api-todos', args=[project.pk]), {'text': text, 'parent': parent})

    def test_cards_nest_three_levels_then_stop(self):
        level2 = Project.objects.get(pk=self.add_card(self.top).json()['id'])
        level3 = Project.objects.get(pk=self.add_card(level2).json()['id'])
        self.assertEqual(level3.depth(), 3)
        self.assertEqual(self.add_card(level3).status_code, 400)

    def test_cannot_nest_under_another_users_card(self):
        theirs = Project.objects.create(owner=self.other, name='Theirs')
        self.assertEqual(self.add_card(theirs).status_code, 404)

    def test_bad_parent_value_is_rejected(self):
        response = self.post(reverse('api-projects'), {'name': 'X', 'parent': 'abc'})
        self.assertEqual(response.status_code, 400)

    def test_todos_nest_three_levels_then_stop(self):
        t1 = self.add_todo(self.top).json()['id']
        t2 = self.add_todo(self.top, parent=t1).json()['id']
        t3 = self.add_todo(self.top, parent=t2).json()['id']
        self.assertEqual(Todo.objects.get(pk=t3).depth(), 3)
        self.assertEqual(self.add_todo(self.top, parent=t3).status_code, 400)

    def test_subtasks_get_increasing_order(self):
        t1 = self.add_todo(self.top).json()['id']
        orders = [self.add_todo(self.top, f'Sub {i}', parent=t1).json()['order'] for i in range(3)]
        self.assertEqual(orders, [0, 1, 2])

    def test_todo_parent_must_be_in_same_project(self):
        elsewhere = Project.objects.create(owner=self.me, name='Elsewhere')
        foreign = Todo.objects.create(project=elsewhere, text='Not here')
        self.assertEqual(self.add_todo(self.top, parent=foreign.pk).status_code, 404)

    def test_todo_and_card_share_top_level_order(self):
        self.add_todo(self.top, 'First')
        card = self.add_card(self.top).json()
        self.add_todo(self.top, 'Third')
        self.assertEqual(card['list_order'], 1)
        self.assertEqual(Todo.objects.get(text='Third').order, 2)

    def test_reorder_mixed_level(self):
        todo = self.add_todo(self.top).json()['id']
        card = self.add_card(self.top).json()['id']
        url = reverse('api-reorder', args=[self.top.pk])
        items = [{'type': 'card', 'id': card}, {'type': 'todo', 'id': todo}]
        self.assertEqual(self.post(url, {'parent': None, 'items': items}).status_code, 204)
        self.assertEqual(Project.objects.get(pk=card).list_order, 0)
        self.assertEqual(Todo.objects.get(pk=todo).order, 1)

    def test_reorder_rejects_incomplete_or_foreign_items(self):
        todo = self.add_todo(self.top).json()['id']
        self.add_card(self.top)
        foreign = Todo.objects.create(project=Project.objects.create(owner=self.other, name='O'), text='X')
        url = reverse('api-reorder', args=[self.top.pk])
        for items in ([{'type': 'todo', 'id': todo}], [{'type': 'todo', 'id': foreign.pk}], [{'id': [1]}]):
            self.assertEqual(self.post(url, {'parent': None, 'items': items}).status_code, 400, items)

    def test_todo_note_position_saves(self):
        t = self.add_todo(self.top).json()
        self.assertEqual((t['x'], t['y']), (None, None))  # not placed on the board yet
        url = reverse('api-todo', args=[t['id']])
        response = self.client.patch(url, {'x': 240, 'y': 96}, content_type='application/json')
        self.assertEqual((response.json()['x'], response.json()['y']), (240, 96))
        self.assertEqual(self.client.patch(url, {'x': 'left'}, content_type='application/json').status_code, 400)

    def test_todo_update_and_delete_cascades(self):
        t1 = self.add_todo(self.top).json()['id']
        self.add_todo(self.top, parent=t1)
        url = reverse('api-todo', args=[t1])
        response = self.client.patch(url, {'done': True, 'due': '2026-11-01'}, content_type='application/json')
        self.assertEqual(response.json()['due'], '2026-11-01')
        cleared = self.client.patch(url, {'due': ''}, content_type='application/json')
        self.assertIsNone(cleared.json()['due'])
        self.assertEqual(self.client.delete(url).status_code, 204)
        self.assertFalse(Todo.objects.exists())

    def test_other_users_todo_is_hidden(self):
        foreign = Todo.objects.create(project=Project.objects.create(owner=self.other, name='O'), text='X')
        url = reverse('api-todo', args=[foreign.pk])
        self.assertEqual(self.client.patch(url, {'done': True}, content_type='application/json').status_code, 404)
        self.assertEqual(self.client.delete(url).status_code, 404)

    def test_links_validate_url(self):
        url = reverse('api-links', args=[self.top.pk])
        self.assertEqual(self.post(url, {'label': 'Docs', 'url': 'https://example.com'}).status_code, 201)
        self.assertEqual(self.post(url, {'label': 'Bad', 'url': 'not a url'}).status_code, 400)
        self.assertEqual(self.post(url, {'label': 'JS', 'url': 'javascript:alert(1)'}).status_code, 400)

    def test_areas_only_on_cards_with_a_board(self):
        level2 = Project.objects.create(owner=self.me, name='L2', parent=self.top)
        level3 = Project.objects.create(owner=self.me, name='L3', parent=level2)
        body = {'name': 'Parts', 'x': 0, 'y': 0, 'w': 400, 'h': 300}
        self.assertEqual(self.post(reverse('api-areas', args=[self.top.pk]), body).status_code, 201)
        self.assertEqual(self.post(reverse('api-areas', args=[level3.pk]), body).status_code, 400)

    def test_deleting_card_removes_its_subtree(self):
        child = Project.objects.get(pk=self.add_card(self.top).json()['id'])
        self.add_card(child)
        self.add_todo(child)
        self.assertEqual(self.client.delete(reverse('api-project', args=[self.top.pk])).status_code, 204)
        self.assertFalse(Project.objects.exists())
        self.assertFalse(Todo.objects.exists())


class MoveBetweenLevelsTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user('me', password='pw-test-123')
        self.other = User.objects.create_user('other', password='pw-test-123')
        self.top = Project.objects.create(owner=self.me, name='Top', zone='projects')
        self.client.force_login(self.me)

    def post(self, name, pk, data):
        return self.client.post(reverse(name, args=[pk]), data, content_type='application/json')

    def todo(self, text, parent=None, order=0, project=None, **extra):
        return Todo.objects.create(project=project or self.top, text=text, parent=parent, order=order, **extra)

    def test_indent_makes_it_a_subtask_of_the_item_above(self):
        a, b = self.todo('A', order=0), self.todo('B', order=1)
        self.assertEqual(self.post('api-todo-move', b.pk, {'parent': a.pk, 'after': None}).status_code, 200)
        b.refresh_from_db()
        self.assertEqual(b.parent, a)

    def test_outdent_lands_right_after_its_old_parent(self):
        a = self.todo('A', order=0)
        self.todo('C', order=1)
        child = self.todo('child', parent=a)
        response = self.post('api-todo-move', child.pk, {'parent': None, 'after': {'type': 'todo', 'id': a.pk}})
        self.assertEqual(response.status_code, 200)
        top_level = Todo.objects.filter(project=self.top, parent=None).order_by('order')
        self.assertEqual([t.text for t in top_level], ['A', 'child', 'C'])

    def test_move_respects_depth_limit_including_subtasks(self):
        a = self.todo('A')
        b = self.todo('B', parent=a)
        moving = self.todo('moving', order=1)
        self.todo('its child', parent=moving)
        # B is level 2; moving plus its child would reach level 4.
        self.assertEqual(self.post('api-todo-move', moving.pk, {'parent': b.pk}).status_code, 400)

    def test_cannot_move_a_task_inside_itself(self):
        a = self.todo('A')
        child = self.todo('child', parent=a)
        self.assertEqual(self.post('api-todo-move', a.pk, {'parent': child.pk}).status_code, 400)

    def test_cannot_move_into_another_project_or_users_task(self):
        mine = self.todo('mine')
        elsewhere = self.todo('elsewhere', project=Project.objects.create(owner=self.me, name='Other card'))
        self.assertEqual(self.post('api-todo-move', mine.pk, {'parent': elsewhere.pk}).status_code, 404)
        theirs = Todo.objects.create(project=Project.objects.create(owner=self.other, name='X'), text='X')
        self.assertEqual(self.post('api-todo-move', theirs.pk, {'parent': None}).status_code, 404)

    def test_to_card_moves_subtasks_and_keeps_due_date(self):
        floor = self.todo('Floor mats', order=3, due='2026-11-01')
        sub = self.todo('Measure', parent=floor, order=0)
        deep = self.todo('Front pair', parent=sub)
        response = self.post('api-todo-to-card', floor.pk, {'x': 48, 'y': 96})
        self.assertEqual(response.status_code, 201)
        card = Project.objects.get(pk=response.json()['id'])
        self.assertEqual((card.parent, card.name, card.list_order, card.x), (self.top, 'Floor mats', 3, 48))
        self.assertFalse(Todo.objects.filter(pk=floor.pk).exists())
        top_level = card.todos.filter(parent=None).order_by('order')
        self.assertEqual([(t.text, str(t.due)) for t in top_level], [('Floor mats', '2026-11-01'), ('Measure', 'None')])
        deep.refresh_from_db()
        self.assertEqual((deep.project, deep.parent.text), (card, 'Measure'))

    def test_to_card_refused_on_level_three(self):
        level3 = Project.objects.create(owner=self.me, name='L3', parent=Project.objects.create(
            owner=self.me, name='L2', parent=self.top))
        t = self.todo('task', project=level3)
        self.assertEqual(self.post('api-todo-to-card', t.pk, {}).status_code, 400)
        self.assertTrue(Todo.objects.filter(pk=t.pk).exists())

    def test_move_card_into_another_card_and_back(self):
        other = Project.objects.create(owner=self.me, name='Other', zone='trips')
        response = self.post('api-project-move', self.top.pk, {'parent': other.pk, 'x': 24, 'y': 48})
        self.assertEqual(response.status_code, 200)
        self.top.refresh_from_db()
        self.assertEqual(self.top.parent, other)
        response = self.post('api-project-move', self.top.pk, {'parent': None, 'zone': 'school', 'x': 0, 'y': 700})
        self.top.refresh_from_db()
        self.assertEqual((self.top.parent, self.top.zone), (None, 'school'))

    def test_move_card_respects_depth_and_cycles(self):
        child = Project.objects.create(owner=self.me, name='Child', parent=self.top)
        self.assertEqual(self.post('api-project-move', self.top.pk, {'parent': child.pk}).status_code, 400)
        deep_target = Project.objects.create(owner=self.me, name='L2', parent=Project.objects.create(
            owner=self.me, name='Elsewhere'))
        # Top has a child, so it needs two levels; under a level-2 card it would reach level 4.
        self.assertEqual(self.post('api-project-move', self.top.pk, {'parent': deep_target.pk}).status_code, 400)

    def test_cannot_move_card_into_other_users_card(self):
        theirs = Project.objects.create(owner=self.other, name='Theirs')
        self.assertEqual(self.post('api-project-move', self.top.pk, {'parent': theirs.pk}).status_code, 404)


class PreferencesTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user('me', password='pw-test-123')
        self.client.force_login(self.me)
        self.url = reverse('api-preferences')

    def patch(self, data):
        return self.client.patch(self.url, data, content_type='application/json')

    def test_asks_before_deleting_by_default(self):
        self.assertEqual(self.client.get(self.url).json(), {'confirm_deletes': True})

    def test_setting_is_saved_per_user(self):
        self.assertEqual(self.patch({'confirm_deletes': False}).status_code, 200)
        self.assertFalse(self.client.get(self.url).json()['confirm_deletes'])
        other = User.objects.create_user('other', password='pw-test-123')
        self.client.force_login(other)
        self.assertTrue(self.client.get(self.url).json()['confirm_deletes'])

    def test_rejects_unknown_or_invalid_values(self):
        self.assertEqual(self.patch({'user': 5}).status_code, 400)
        self.assertEqual(self.patch({'confirm_deletes': 'maybe'}).status_code, 400)

    def test_requires_login(self):
        self.client.logout()
        self.assertEqual(self.client.get(self.url).status_code, 401)

    def test_board_page_includes_preferences(self):
        Preferences.objects.create(user=self.me, confirm_deletes=False)
        self.assertContains(self.client.get(reverse('board')), '"confirm_deletes": false')


PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 32
PDF = b'%PDF-1.7\n' + b'\x00' * 32


class AttachmentTests(TestCase):
    def setUp(self):
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, ignore_errors=True)
        override = override_settings(MEDIA_ROOT=self.media)
        override.enable()
        self.addCleanup(override.disable)
        self.me = User.objects.create_user('me', password='pw-test-123')
        self.other = User.objects.create_user('other', password='pw-test-123')
        self.project = Project.objects.create(owner=self.me, name='Mine')
        self.client.force_login(self.me)

    def upload(self, name, content, project=None):
        url = reverse('api-attachments', args=[(project or self.project).pk])
        return self.client.post(url, {'file': SimpleUploadedFile(name, content)})

    def test_upload_image_and_pdf(self):
        png = self.upload('photo.png', PNG)
        pdf = self.upload('Syllabus.pdf', PDF)
        self.assertEqual((png.status_code, pdf.status_code), (201, 201))
        self.assertEqual((png.json()['kind'], pdf.json()['kind']), ('image', 'pdf'))
        self.assertEqual(pdf.json()['name'], 'Syllabus.pdf')
        listed = self.client.get(reverse('api-projects')).json()['projects'][0]['attachments']
        self.assertEqual([a['name'] for a in listed], ['photo.png', 'Syllabus.pdf'])

    def test_type_comes_from_contents_not_name(self):
        self.assertEqual(self.upload('notes.txt.png', b'just some text').status_code, 400)
        self.assertEqual(self.upload('page.html', b'<script>alert(1)</script>').status_code, 400)
        response = self.upload('looks-like.html', PNG)  # real PNG with a misleading name
        self.assertEqual(response.status_code, 201)
        stored = Attachment.objects.get(pk=response.json()['id'])
        self.assertTrue(stored.file.name.endswith('.png'))
        self.assertEqual(stored.content_type, 'image/png')

    @override_settings(MAX_UPLOAD_BYTES=20)
    def test_rejects_large_files(self):
        self.assertEqual(self.upload('big.png', PNG).status_code, 400)

    def test_file_is_served_to_owner_only(self):
        a_id = self.upload('photo.png', PNG).json()['id']
        url = reverse('attachment-file', args=[a_id])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'image/png')
        self.assertEqual(b''.join(response.streaming_content), PNG)
        self.client.force_login(self.other)
        self.assertEqual(self.client.get(url).status_code, 404)
        self.client.logout()
        self.assertEqual(self.client.get(url).status_code, 302)

    def test_cannot_upload_to_other_users_project(self):
        theirs = Project.objects.create(owner=self.other, name='Theirs')
        self.assertEqual(self.upload('photo.png', PNG, project=theirs).status_code, 404)

    def test_delete_removes_file(self):
        a_id = self.upload('photo.png', PNG).json()['id']
        path = Path(Attachment.objects.get(pk=a_id).file.path)
        self.assertTrue(path.exists())
        self.client.force_login(self.other)
        self.assertEqual(self.client.delete(reverse('api-attachment', args=[a_id])).status_code, 404)
        self.client.force_login(self.me)
        self.assertEqual(self.client.delete(reverse('api-attachment', args=[a_id])).status_code, 204)
        self.assertFalse(path.exists())

    def test_deleting_project_removes_its_files(self):
        self.upload('photo.png', PNG)
        path = Path(Attachment.objects.get().file.path)
        self.client.delete(reverse('api-project', args=[self.project.pk]))
        self.assertFalse(path.exists())

    @override_settings(MAX_UPLOAD_BYTES=1024)
    def test_oversized_upload_is_stopped_while_streaming(self):
        response = self.upload('big.png', PNG + b'\x00' * 200_000)
        self.assertEqual(response.status_code, 400)
        self.assertIn('at most', response.json()['error'])
        self.assertFalse(Attachment.objects.exists())


class LoginThrottleTests(TestCase):
    def setUp(self):
        User.objects.create_user('me', password='right-password-123')
        self.url = reverse('login')

    def attempt(self, password, ip='10.0.0.1'):
        return self.client.post(self.url, {'username': 'me', 'password': password}, REMOTE_ADDR=ip)

    def test_locks_out_after_five_failures_even_with_the_right_password(self):
        for _ in range(5):
            self.assertEqual(self.attempt('wrong').status_code, 200)
        response = self.attempt('right-password-123')
        self.assertEqual(response.status_code, 429)
        self.assertContains(response, 'Too many failed attempts', status_code=429)
        self.assertNotIn('_auth_user_id', self.client.session)

    def test_lockout_is_per_address(self):
        for _ in range(5):
            self.attempt('wrong')
        self.assertEqual(self.attempt('right-password-123', ip='10.0.0.2').status_code, 302)

    def test_successful_login_resets_the_count(self):
        for _ in range(4):
            self.attempt('wrong')
        self.assertEqual(self.attempt('right-password-123').status_code, 302)
        self.client.logout()
        for _ in range(4):
            self.attempt('wrong')
        self.assertEqual(self.attempt('right-password-123').status_code, 302)

    def test_count_is_stored_in_the_database_and_expires(self):
        for _ in range(5):
            self.attempt('wrong')
        self.assertEqual(LoginAttempts.objects.get(key='login:10.0.0.1').count, 5)
        # Once the 15-minute window has passed, the address gets a fresh start.
        LoginAttempts.objects.update(window_start=timezone.now() - timedelta(minutes=16))
        self.assertEqual(self.attempt('right-password-123').status_code, 302)
        self.assertFalse(LoginAttempts.objects.exists())

    def test_expired_rows_from_other_addresses_are_cleaned_up(self):
        old = timezone.now() - timedelta(minutes=16)
        LoginAttempts.objects.bulk_create(LoginAttempts(key=f'login:10.9.0.{i}', count=3, window_start=old) for i in range(50))
        self.attempt('wrong')
        self.assertEqual(list(LoginAttempts.objects.values_list('key', flat=True)), ['login:10.0.0.1'])

    def test_admin_login_goes_through_the_throttled_page(self):
        response = self.client.get('/admin/login/')
        self.assertRedirects(response, '/login/?next=/admin/', fetch_redirect_response=False)


class HardeningTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user('me', password='pw-test-123')
        self.project = Project.objects.create(owner=self.me, name='Mine')
        self.client.force_login(self.me)

    def test_pages_send_a_content_security_policy(self):
        policy = self.client.get(reverse('board'))['Content-Security-Policy']
        self.assertIn("script-src 'self'", policy)
        self.assertIn("frame-ancestors 'none'", policy)

    def test_csrf_cookie_is_not_readable_by_scripts(self):
        self.client.logout()
        response = self.client.get(reverse('login'))
        self.assertTrue(response.cookies['csrftoken']['httponly'])

    def test_nan_and_infinity_are_rejected(self):
        url = reverse('api-project', args=[self.project.pk])
        for body in ('{"x": NaN}', '{"y": Infinity}', '{"x": -Infinity}'):
            self.assertEqual(self.client.patch(url, body, content_type='application/json').status_code, 400, body)

    def test_huge_ids_give_not_found_instead_of_a_crash(self):
        self.assertEqual(self.client.delete('/api/todos/99999999999999999999999/').status_code, 404)
        response = self.client.post(reverse('api-projects'), {'name': 'X', 'parent': 10**30}, content_type='application/json')
        self.assertEqual(response.status_code, 400)


ICS = b"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:exam3
SUMMARY:Exam 3
DTSTART;VALUE=DATE:20991105
END:VEVENT
BEGIN:VEVENT
UID:lecture
SUMMARY:Lecture
DTSTART:20991102T090000Z
DTEND:20991102T095000Z
RRULE:FREQ=WEEKLY;COUNT=10
END:VEVENT
END:VCALENDAR
"""


@override_settings(MEDIA_ROOT=tempfile.gettempdir())
class ScheduleImportTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user('me', password='pw-test-123')
        self.client.force_login(self.me)
        self.url = reverse('api-schedule-read')

    def read(self, name, content):
        return self.client.post(self.url, {'file': SimpleUploadedFile(name, content)})

    def test_calendar_file_lists_upcoming_events_once(self):
        with patch('board.schedule.date') as fake_date:
            fake_date.today.return_value = date(2099, 11, 1)
            fake_date.fromisoformat = date.fromisoformat
            response = self.read('cal.ics', ICS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['items'], [
            {'title': 'Lecture (repeats)', 'date': '2099-11-02'},
            {'title': 'Exam 3', 'date': '2099-11-05'},
        ])

    def test_broken_calendar_file_is_rejected(self):
        self.assertEqual(self.read('cal.ics', b'BEGIN:VCALENDAR\nnot really').status_code, 400)

    def test_other_files_are_rejected(self):
        self.assertEqual(self.read('notes.txt', b'hello').status_code, 400)
        self.assertEqual(self.read('doc.pdf', PDF).status_code, 400)

    @patch.dict(os.environ, {'ANTHROPIC_API_KEY': ''})
    def test_image_needs_an_api_key(self):
        self.assertEqual(self.read('schedule.png', PNG).status_code, 503)

    @patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'test-key'})
    @patch('board.views.read_schedule_image', return_value=[{'title': 'Quiz 6', 'date': '2026-10-15'}])
    def test_image_returns_items_for_review_without_saving(self, fake_read):
        response = self.read('schedule.png', PNG)
        self.assertEqual(response.json(), {'source': 'image', 'items': [{'title': 'Quiz 6', 'date': '2026-10-15'}]})
        self.assertFalse(Todo.objects.exists())

    @patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'test-key'})
    @patch('board.views.read_schedule_image', return_value=[])
    def test_daily_image_limit(self, fake_read):
        for _ in range(30):
            self.assertEqual(self.read('schedule.png', PNG).status_code, 200)
        self.assertEqual(self.read('schedule.png', PNG).status_code, 429)
        self.assertEqual(fake_read.call_count, 30)

    def test_requires_login(self):
        self.client.logout()
        self.assertEqual(self.read('cal.ics', ICS).status_code, 401)

    def test_item_cleanup(self):
        items = clean_items([{'title': '  Quiz   6 ', 'date': '2026-10-15'}, {'title': '', 'date': '2026-01-01'},
                             {'title': 'No date', 'date': 'soon'}, 'junk', {'title': 'x' * 300, 'date': ''}])
        self.assertEqual(items[:2], [{'title': 'Quiz 6', 'date': '2026-10-15'}, {'title': 'No date', 'date': None}])
        self.assertEqual(len(items[2]['title']), 200)

    def test_runaway_repeating_event_is_capped(self):
        every_second = (b'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:s\r\nSUMMARY:Every second\r\n'
                        b'DTSTART:20991101T000000Z\r\nRRULE:FREQ=SECONDLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')
        started = time.monotonic()
        items = read_ics(every_second, today=date(2099, 11, 1))
        self.assertEqual(items, [{'title': 'Every second (repeats)', 'date': '2099-11-01'}])
        self.assertLess(time.monotonic() - started, 15)

    @staticmethod
    def calendar(*events):
        body = ''.join(f'BEGIN:VEVENT\r\n{e}END:VEVENT\r\n' for e in events)
        return f'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\n{body}END:VCALENDAR\r\n'.encode()

    def test_hostile_calendar_files_finish_quickly(self):
        today = date(2026, 10, 21)
        fast = self.calendar(*(f'UID:s{i}\r\nSUMMARY:S{i}\r\nDTSTART:20200101T000000Z\r\nRRULE:FREQ=SECONDLY\r\n' for i in range(50)))
        daily = self.calendar(*(f'UID:d{i}\r\nSUMMARY:D{i}\r\nDTSTART;VALUE=DATE:19700101\r\nRRULE:FREQ=DAILY\r\n' for i in range(1000)))
        for content in (fast, daily):
            started = time.monotonic()
            items = read_ics(content, today=today)
            self.assertLess(time.monotonic() - started, 10)
            self.assertTrue(items)
        # Once the shared step budget runs out, the rest are still listed, undated, for the review step.
        self.assertIn(None, [item['date'] for item in read_ics(daily, today=today)])
        # Rules that can never match ("February 30th") would make dateutil search for centuries.
        never = self.calendar(*(f'UID:n{i}\r\nSUMMARY:N\r\nDTSTART;VALUE=DATE:00010101\r\n'
                                f'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30\r\n' for i in range(1000)))
        # A daily rule that lists every hour, minute and second matches 86,400 times a day.
        every_second = 'RRULE:FREQ=DAILY;BYHOUR={};BYMINUTE={};BYSECOND={}\r\n'.format(
            ','.join(map(str, range(24))), ','.join(map(str, range(60))), ','.join(map(str, range(60))))
        dense = self.calendar(*(f'UID:t{i}\r\nSUMMARY:T\r\nDTSTART:20260101T000000\r\n{every_second}' for i in range(200)))
        for content in (never, dense):
            started = time.monotonic()
            read_ics(content, today=today)
            self.assertLess(time.monotonic() - started, 10)
        too_many = self.calendar(*(f'UID:x{i}\r\nSUMMARY:X\r\nDTSTART;VALUE=DATE:20261101\r\n' for i in range(1001)))
        with self.assertRaisesMessage(ScheduleReadError, 'more than 1000 events'):
            read_ics(too_many, today=today)

    def test_repeating_event_shows_its_next_date(self):
        today = date(2026, 10, 21)  # a Wednesday
        content = self.calendar(
            'UID:mon\r\nSUMMARY:Lab\r\nDTSTART:20260105T140000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\n',
            'UID:ended\r\nSUMMARY:Old class\r\nDTSTART:20260105T140000Z\r\nRRULE:FREQ=WEEKLY;UNTIL=20260501T000000Z\r\n',
            'UID:hourly\r\nSUMMARY:Ping\r\nDTSTART:20260101T000000Z\r\nRRULE:FREQ=HOURLY;UNTIL=20260201T000000Z\r\n',
            'UID:used\r\nSUMMARY:Five days\r\nDTSTART;VALUE=DATE:20261001\r\nRRULE:FREQ=DAILY;COUNT=5\r\n',
            'UID:left\r\nSUMMARY:Thirty days\r\nDTSTART;VALUE=DATE:20261001\r\nRRULE:FREQ=DAILY;COUNT=30\r\n',
        )
        self.assertEqual(read_ics(content, today=today), [
            {'title': 'Thirty days (repeats)', 'date': '2026-10-21'},
            {'title': 'Lab (repeats)', 'date': '2026-10-26'},
        ])

    def test_image_claiming_huge_dimensions_is_refused_before_decoding(self):
        # A small PNG file whose header declares 10000 x 6000 pixels (60 million).
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        ihdr = struct.pack('>IIBBBBB', 10000, 6000, 8, 2, 0, 0, 0)
        png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(b'\x00' * 1000))
               + chunk(b'IEND', b''))
        self.assertLess(len(png), 1000)
        with self.assertRaisesMessage(ScheduleReadError, 'too large'):
            prepare_image(io.BytesIO(png))

    def test_photos_are_shrunk_and_stripped_of_metadata(self):
        photo = io.BytesIO()
        exif = Image.Exif()
        exif[0x010F] = 'PhoneMaker'  # camera make; GPS would be stripped the same way
        Image.new('RGB', (5000, 1000), 'white').save(photo, format='JPEG', exif=exif)
        photo.seek(0)
        out = Image.open(io.BytesIO(base64.b64decode(prepare_image(photo))))
        self.assertEqual(max(out.size), 2576)
        self.assertEqual(len(out.getexif()), 0)


class CalendarFeedTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user('me', password='pw-test-123')
        self.other = User.objects.create_user('other', password='pw-test-123')
        card = Project.objects.create(owner=self.me, name='Math 101')
        Todo.objects.create(project=card, text='Quiz 6', due='2026-10-15')
        Todo.objects.create(project=card, text='Finished quiz', due='2026-10-01', done=True)
        Todo.objects.create(project=card, text='No date')
        theirs = Project.objects.create(owner=self.other, name='Theirs')
        Todo.objects.create(project=theirs, text='Their secret', due='2026-10-20')
        self.client.force_login(self.me)

    def feed_url(self):
        return self.client.get(reverse('api-calendar-link')).json()['url']

    def test_feed_lists_only_my_open_dated_todos(self):
        response = self.client.get(self.feed_url())
        self.assertEqual(response['Content-Type'], 'text/calendar; charset=utf-8')
        body = response.content.decode()
        self.assertIn('SUMMARY:Quiz 6', body)
        self.assertIn('DTSTART;VALUE=DATE:20261015', body)
        self.assertNotIn('Finished quiz', body)
        self.assertNotIn('No date', body)
        self.assertNotIn('Their secret', body)

    def test_feed_works_without_login_but_not_with_a_wrong_token(self):
        url = self.feed_url()
        self.client.logout()
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self.client.get('/calendar/' + 'x' * 43 + '.ics').status_code, 404)

    def test_link_stays_the_same_until_replaced(self):
        first = self.feed_url()
        self.assertEqual(self.feed_url(), first)
        new = self.client.post(reverse('api-calendar-link')).json()['url']
        self.assertNotEqual(new, first)
        self.assertEqual(self.client.get(first).status_code, 404)
        self.assertEqual(self.client.get(new).status_code, 200)

    def test_link_requires_login(self):
        self.client.logout()
        self.assertEqual(self.client.get(reverse('api-calendar-link')).status_code, 401)
