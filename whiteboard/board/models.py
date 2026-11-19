import uuid
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models.signals import post_delete
from django.dispatch import receiver
from django.utils import timezone

# Cards nest three levels below the main board (Car > Exhaust > Parts);
# to-dos nest three levels too (task > sub-task > sub-sub-task).
MAX_DEPTH = 3


def depth_of(node):
    depth, parent = 1, node.parent
    while parent is not None:
        depth, parent = depth + 1, parent.parent
    return depth


class Project(models.Model):
    class Zone(models.TextChoices):
        PROJECTS = 'projects', 'Projects'
        TRIPS = 'trips', 'Trips'
        SCHOOL = 'school', 'School'
        OTHER = 'other', 'Other Tasks'

    class Status(models.TextChoices):
        NOT_STARTED = 'not_started', 'Not started'
        ACTIVE = 'active', 'Active'
        WAITING = 'waiting', 'Waiting'
        DONE = 'done', 'Done'

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='projects')
    parent = models.ForeignKey('self', null=True, blank=True, on_delete=models.CASCADE, related_name='children')
    name = models.CharField(max_length=200)
    # Only used for top-level cards; sub-cards live on their parent's board.
    zone = models.CharField(max_length=20, choices=Zone, default=Zone.OTHER)
    status = models.CharField(max_length=20, choices=Status, default=Status.NOT_STARTED)
    # Position on the board it sits on (main board or the parent's board), in board pixels.
    x = models.FloatField(default=0)
    y = models.FloatField(default=0)
    collapsed = models.BooleanField(default=False)
    # Position in the parent's to-do list, shared with the parent's top-level Todo.order values.
    list_order = models.PositiveIntegerField(default=0)
    notes = models.TextField(blank=True)
    is_demo = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['zone', 'created_at']

    def __str__(self):
        return self.name

    def depth(self):
        return depth_of(self)

    def clean(self):
        if self.parent is None:
            return
        if self.parent.owner_id != self.owner_id:
            raise ValidationError({'parent': 'Parent belongs to another user.'})
        if self.parent.depth() >= MAX_DEPTH:
            raise ValidationError({'parent': f'Cards can only nest {MAX_DEPTH} levels deep.'})


class Todo(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='todos')
    parent = models.ForeignKey('self', null=True, blank=True, on_delete=models.CASCADE, related_name='subtasks')
    text = models.CharField(max_length=500)
    done = models.BooleanField(default=False)
    due = models.DateField(null=True, blank=True)
    order = models.PositiveIntegerField(default=0)
    # Where the to-do's note sits on its project's mini board; empty until it is first placed.
    x = models.FloatField(null=True, blank=True)
    y = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ['order', 'id']

    def __str__(self):
        return self.text

    def depth(self):
        return depth_of(self)

    def clean(self):
        if self.parent is None:
            return
        if self.parent.project_id != self.project_id:
            raise ValidationError({'parent': 'Parent task is in another project.'})
        if self.parent.depth() >= MAX_DEPTH:
            raise ValidationError({'parent': f'Tasks can only nest {MAX_DEPTH} levels deep.'})


class Preferences(models.Model):
    """Per-user settings, stored on the server so they follow the user to every device."""
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='preferences')
    confirm_deletes = models.BooleanField(default=True)
    # Secret part of the private calendar link; empty until the user first asks for the link.
    calendar_token = models.CharField(max_length=64, blank=True, db_index=True)

    def __str__(self):
        return f'Preferences for {self.user}'

    @classmethod
    def for_user(cls, user):
        return cls.objects.get_or_create(user=user)[0]


class ImageReads(models.Model):
    """How many schedule images a user has had read today, to cap what the API can cost."""
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    day = models.DateField()
    count = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'day'], name='one_image_count_per_day')]


class LoginAttempts(models.Model):
    """Login attempts per client address. Kept in the database so every server process shares one count."""
    key = models.CharField(max_length=100, unique=True)
    count = models.PositiveIntegerField(default=0)
    window_start = models.DateTimeField(default=timezone.now)

    def __str__(self):
        return f'{self.key}: {self.count}'


class Area(models.Model):
    """A named zone the user draws on a project's mini whiteboard."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='areas')
    name = models.CharField(max_length=100)
    x = models.FloatField(default=0)
    y = models.FloatField(default=0)
    w = models.FloatField(default=520)
    h = models.FloatField(default=360)

    def __str__(self):
        return self.name

    def clean(self):
        if self.project.depth() >= MAX_DEPTH:
            raise ValidationError(f'Level-{MAX_DEPTH} cards have no board.')
        if self.w < 120 or self.h < 80:
            raise ValidationError('Zone is too small.')


class Link(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='links')
    label = models.CharField(max_length=200)
    url = models.URLField(max_length=1000)

    def __str__(self):
        return self.label


def attachment_path(instance, filename):
    # Random stored name, so user-supplied filenames never reach the filesystem.
    return f'attachments/{instance.project.owner_id}/{uuid.uuid4().hex}{Path(filename).suffix.lower()}'


class Attachment(models.Model):
    class Kind(models.TextChoices):
        PDF = 'pdf', 'PDF'
        IMAGE = 'image', 'Image'

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='attachments')
    file = models.FileField(upload_to=attachment_path)
    original_name = models.CharField(max_length=255)
    kind = models.CharField(max_length=10, choices=Kind, default=Kind.IMAGE)
    # Content type detected from the file's first bytes, used when serving it back.
    content_type = models.CharField(max_length=50, default='application/octet-stream')
    size = models.PositiveIntegerField(default=0)
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['uploaded_at', 'id']

    def __str__(self):
        return self.original_name


@receiver(post_delete, sender=Attachment)
def delete_attachment_file(sender, instance, **kwargs):
    # Runs for direct deletes and for cascades from a deleted project, so no file is left behind.
    instance.file.delete(save=False)
