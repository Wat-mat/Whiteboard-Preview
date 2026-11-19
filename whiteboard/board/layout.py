"""Fixed board regions, in board pixels. Shared with the front end."""

ZONES = {
    'projects': {'label': 'Projects', 'x': 0, 'y': 0, 'w': 1180, 'h': 640},
    'trips': {'label': 'Trips', 'x': 1220, 'y': 0, 'w': 780, 'h': 640},
    'school': {'label': 'School', 'x': 0, 'y': 680, 'w': 1180, 'h': 640},
    'other': {'label': 'Other Tasks', 'x': 1220, 'y': 680, 'w': 780, 'h': 640},
    'done': {'label': 'Done', 'x': 0, 'y': 1360, 'w': 2000, 'h': 340},
}

CARD_W = 220
CARD_H = 110
GAP_X = 250
GAP_Y = 140
PAD_X = 24
PAD_Y = 56  # leaves room for the zone heading


def slot(region, index, columns):
    """Top-left position of the index-th grid slot inside a region."""
    z = ZONES[region]
    return (
        z['x'] + PAD_X + (index % columns) * GAP_X,
        z['y'] + PAD_Y + (index // columns) * GAP_Y,
    )
