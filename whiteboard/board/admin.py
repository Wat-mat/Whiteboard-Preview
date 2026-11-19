from django.contrib import admin

from .models import Attachment, Link, Project, Todo


class TodoInline(admin.TabularInline):
    model = Todo
    extra = 0


class LinkInline(admin.TabularInline):
    model = Link
    extra = 0


class AttachmentInline(admin.TabularInline):
    model = Attachment
    extra = 0


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ['name', 'parent', 'zone', 'status', 'owner', 'is_demo']
    list_filter = ['zone', 'status', 'is_demo']
    inlines = [TodoInline, LinkInline, AttachmentInline]
