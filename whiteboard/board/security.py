"""Login throttling, an upload size guard, and a URL converter that keeps ids in range."""
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.forms import AuthenticationForm
from django.contrib.auth.views import LoginView
from django.core.files.uploadhandler import FileUploadHandler, StopUpload
from django.db.models import F
from django.utils import timezone

from .models import LoginAttempts

LOGIN_ATTEMPTS = 5
LOCKOUT_SECONDS = 15 * 60


def client_ip(request):
    # Behind a proxy (like PythonAnywhere's) the real address arrives in a header named by CLIENT_IP_HEADER.
    return request.META.get(settings.CLIENT_IP_HEADER) or request.META.get('REMOTE_ADDR', '')


def reserve_attempt(key):
    """Counts one login attempt for `key` and returns the total in the current 15-minute window.

    The count goes up in a single UPDATE before the password is checked, so attempts sent in
    parallel cannot all slip in under the limit.
    """
    # Forget every expired window (any address), so the table only ever holds the last 15 minutes.
    LoginAttempts.objects.filter(window_start__lt=timezone.now() - timedelta(seconds=LOCKOUT_SECONDS)).delete()
    LoginAttempts.objects.get_or_create(key=key)  # handles two requests creating the row at once
    LoginAttempts.objects.filter(key=key).update(count=F('count') + 1)
    return LoginAttempts.objects.values_list('count', flat=True).get(key=key)


class ThrottledLoginView(LoginView):
    """Login page that allows 5 attempts per address per 15 minutes; a successful login clears the count.

    Once over the limit the password is not even checked, so guessing gets nowhere.
    """

    def lock_key(self):
        return f'login:{client_ip(self.request)}'[:100]

    def post(self, request, *args, **kwargs):
        if reserve_attempt(self.lock_key()) > LOGIN_ATTEMPTS:
            # An unbound form: binding the posted data would check the password while showing errors.
            context = self.get_context_data(form=AuthenticationForm(request), locked=True)
            return self.render_to_response(context, status=429)
        return super().post(request, *args, **kwargs)

    def form_valid(self, form):
        LoginAttempts.objects.filter(key=self.lock_key()).delete()
        return super().form_valid(form)


class UploadSizeLimitHandler(FileUploadHandler):
    """Stops reading an upload once it passes MAX_UPLOAD_BYTES, instead of first saving it all to disk.

    Must come first in FILE_UPLOAD_HANDLERS so it sees every chunk before the default handlers store it.
    """

    def new_file(self, *args, **kwargs):
        super().new_file(*args, **kwargs)
        self.received = 0

    def receive_data_chunk(self, raw_data, start):
        self.received += len(raw_data)
        if self.received > settings.MAX_UPLOAD_BYTES:
            self.request.upload_too_large = True
            raise StopUpload(connection_reset=False)  # discard the rest, then answer with an error
        return raw_data

    def file_complete(self, file_size):
        return None


class IdConverter:
    """Like <int:...> but at most 18 digits, so huge numbers give 404 instead of a database error."""
    regex = '[0-9]{1,18}'

    def to_python(self, value):
        return int(value)

    def to_url(self, value):
        return str(value)
