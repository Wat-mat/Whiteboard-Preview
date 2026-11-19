from django.core.management.base import BaseCommand

from board.models import Project


class Command(BaseCommand):
    help = 'Delete every project created by load_demo.'

    def handle(self, *args, **options):
        deleted, _ = Project.objects.filter(is_demo=True).delete()
        self.stdout.write(self.style.SUCCESS(f'Deleted {deleted} demo rows.'))
