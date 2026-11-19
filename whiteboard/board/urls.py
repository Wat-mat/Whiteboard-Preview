from django.urls import path, re_path, register_converter

from . import views
from .security import IdConverter

# <id:pk> works like <int:pk> but rejects numbers too big for the database.
register_converter(IdConverter, 'id')

urlpatterns = [
    path('', views.board, name='board'),
    path('api/preferences/', views.preferences, name='api-preferences'),
    path('api/projects/', views.projects, name='api-projects'),
    path('api/projects/<id:pk>/', views.project_detail, name='api-project'),
    path('api/projects/<id:pk>/reorder/', views.reorder, name='api-reorder'),
    path('api/projects/<id:pk>/move/', views.project_move, name='api-project-move'),
    path('api/todos/<id:pk>/move/', views.todo_move, name='api-todo-move'),
    path('api/todos/<id:pk>/to-card/', views.todo_to_card, name='api-todo-to-card'),
    path('api/projects/<id:pk>/todos/', views.todos, name='api-todos'),
    path('api/projects/<id:pk>/links/', views.links, name='api-links'),
    path('api/projects/<id:pk>/areas/', views.areas, name='api-areas'),
    path('api/todos/<id:pk>/', views.todo_detail, name='api-todo'),
    path('api/links/<id:pk>/', views.link_detail, name='api-link'),
    path('api/areas/<id:pk>/', views.area_detail, name='api-area'),
    path('api/projects/<id:pk>/attachments/', views.attachments, name='api-attachments'),
    path('api/attachments/<id:pk>/', views.attachment_detail, name='api-attachment'),
    path('files/<id:pk>/', views.attachment_file, name='attachment-file'),
    path('api/schedule/read/', views.schedule_read, name='api-schedule-read'),
    path('api/calendar-link/', views.calendar_link, name='api-calendar-link'),
    re_path(r'^calendar/(?P<token>[A-Za-z0-9_-]{20,64})\.ics$', views.calendar_feed_view, name='calendar-feed'),
]
