from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from board.layout import ZONES, GAP_X, PAD_X, slot
from board.models import Project, Todo

TODAY = date.today()


def in_days(n):
    """A due date n days from today, so the demo always looks current."""
    return TODAY + timedelta(days=n)


# (zone, name, status, [(todo text, due date or None[, sub-tasks])])
DEMO = [
    ('projects', 'Car Restoration', 'active', [
        ('Diagnose the engine warning light', None, [('Test the purge valve', None)]),
        ('Find a replacement bumper cover', None),
        ('Order floor mats', None),
    ]),
    ('projects', 'Workshop Jig', 'active', [
        ('Draw up the design', None),
        ('Cut and test the first version', None),
    ]),
    ('projects', 'Craft Fair Booklet', 'active', [
        ('Make items to sell', None),
    ]),
    ('projects', 'Budget Tracker App', 'active', [
        ('Continue the local build', None),
    ]),
    ('projects', 'Recipe Box', 'active', [
        ('Keep adding recipes', None),
        ('Eventually make a recipe book', None),
    ]),
    ('projects', 'Notes Search Idea', 'not_started', [
        ('Still brainstorming', None),
        ('Decide on a layout', None),
    ]),
    ('projects', 'Antique Tool Restoration', 'done', [
        ('Add to portfolio', None),
    ]),
    ('trips', 'Weekend Camping Trip', 'active', [
        ('Pack for cold nights', None),
        ('Confirm campsites', None),
    ]),
    ('trips', 'Hiking Trip (3 nights, 3-4 people)', 'not_started', [
        ('Pick dates', None),
        ('Plan route and gear split', None),
    ]),
    ('trips', 'Lake Cabin Weekend', 'done', []),
    ('school', 'Math 101', 'active', [
        ('Quiz 1', in_days(1)),
        ('Online lesson', in_days(2)),
        ('Practice quiz', in_days(5)),
        ('Practice quiz retake', in_days(6)),
        ('Study for Test 1', in_days(10)),
    ]),
    ('school', 'Intro to Programming', 'active', [
        ('Confirm exam date', None),
        ('Project 1 (check the course site for the due date)', None),
        ('Assignment 4', None),
        ('Assignment 5', None),
        ('Exam 1', in_days(12)),
        ('Project 2: Proposal', in_days(7)),
        ('Project 2: Progress report', in_days(14)),
        ('Project 2: Final submission', in_days(28)),
    ]),
    ('school', 'Public Speaking', 'active', [
        ('Reading quiz 1', in_days(3)),
        ('Reading quiz 2', in_days(3)),
        ('Find out the speech date', None),
        ('Prep the speech', None),
    ]),
    ('school', 'Research Paper', 'active', [
        ('Finish the library module', in_days(4)),
        ('Start finding sources', None),
        ('5-page paper (date TBD)', None),
        ('5-minute presentation (date TBD)', None),
    ]),
]


# Sub-cards nested under a demo project: parent name -> [(name, status, todos, sub-cards)]
NESTED = {
    'Car Restoration': [
        ('Exhaust', 'active', [
            ('Decide on a setup', None),
        ], [
            ('Parts', 'not_started', [('Price the parts', None)], []),
        ]),
    ],
}


def add_todos(project, todos, parent=None):
    for i, (text, due, *rest) in enumerate(todos):
        todo = Todo.objects.create(project=project, parent=parent, text=text, due=due, order=i)
        if rest:
            add_todos(project, rest[0], todo)


def add_children(parent, children):
    first = parent.todos.filter(parent=None).count()
    for i, (name, status, todos, grandchildren) in enumerate(children):
        child = Project.objects.create(
            owner=parent.owner, parent=parent, name=name, status=status, is_demo=True,
            x=40 + i * 260, y=40, list_order=first + i,
        )
        add_todos(child, todos)
        add_children(child, grandchildren)


class Command(BaseCommand):
    help = 'Load the example projects onto a user\'s board (marked is_demo).'

    def add_arguments(self, parser):
        parser.add_argument('--user', help='Username to own the demo data (default: first superuser).')

    def handle(self, *args, **options):
        User = get_user_model()
        if options['user']:
            user = User.objects.filter(username=options['user']).first()
        else:
            user = User.objects.filter(is_superuser=True).order_by('id').first()
        if user is None:
            raise CommandError('No matching user. Run createsuperuser first or pass --user.')
        if Project.objects.filter(owner=user, is_demo=True).exists():
            raise CommandError('Demo data already loaded. Run clear_demo first.')

        counts = {}
        done_columns = ZONES['done']['w'] // GAP_X
        for zone, name, status, todos in DEMO:
            region = 'done' if status == 'done' else zone
            index = counts.get(region, 0)
            counts[region] = index + 1
            columns = done_columns if region == 'done' else (ZONES[region]['w'] - PAD_X) // GAP_X
            x, y = slot(region, index, columns)
            project = Project.objects.create(
                owner=user, name=name, zone=zone, status=status, x=x, y=y,
                collapsed=status == 'done', is_demo=True,
            )
            add_todos(project, todos)
            add_children(project, NESTED.get(name, []))
        self.stdout.write(self.style.SUCCESS(f'Loaded {len(DEMO)} demo projects for {user.username}.'))
