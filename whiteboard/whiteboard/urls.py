from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.urls import include, path
from django.views.generic import RedirectView

from board.security import ThrottledLoginView

urlpatterns = [
    # The admin's own login page has no attempt limit, so send it through the throttled one.
    path('admin/login/', RedirectView.as_view(url='/login/?next=/admin/')),
    path('admin/', admin.site.urls),
    path('login/', ThrottledLoginView.as_view(), name='login'),
    path('logout/', auth_views.LogoutView.as_view(), name='logout'),
    path('', include('board.urls')),
]
