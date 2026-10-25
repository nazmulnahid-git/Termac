# dmgbuild settings for the Termorc installer window (see scripts/make-dmg.sh).
# dmgbuild writes the window layout itself, so no Finder scripting is involved.
import os.path

app = defines["app"]  # path to Termorc.app

files = [app]
symlinks = {"Applications": "/Applications"}
icon = os.path.join(app, "Contents/Resources/icon.icns")
format = "UDZO"
filesystem = "HFS+"

# The window: just the two icons on the background, no toolbar, sidebar, path or status bar.
background = defines["background"]
window_rect = ((240, 160), (660, 440))
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
default_view = "icon-view"
icon_size = 112
text_size = 13
arrange_by = None
icon_locations = {"Termorc.app": (180, 170), "Applications": (480, 170)}
