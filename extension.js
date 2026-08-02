'use strict';

const { St, Clutter, GObject, Gio, GLib } = imports.gi;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const HELPER = Me.path + '/ganjoor_helper.py';

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function _python() {
    return GLib.find_program_in_path('python3') ||
           GLib.find_program_in_path('python');
}

function _defaultDbPath() {
    return GLib.build_filenamev(
        [GLib.get_user_data_dir(), 'ganjoor', 'ganjoor.s3db']);
}

// Run helper and collect ALL stdout at once (for `beyt` / `info`).
function spawnCollect(argv, cb) {
    let proc;
    try {
        proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        cb(null, String(e));
        return null;
    }
    proc.communicate_utf8_async(null, null, (p, res) => {
        try {
            let [, stdout, stderr] = p.communicate_utf8_finish(res);
            cb(stdout, stderr);
        } catch (e) {
            cb(null, String(e));
        }
    });
    return proc;
}

// Run helper and stream stdout line-by-line (for `update` progress).
function spawnStream(argv, onLine, onExit) {
    let proc;
    try {
        proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        onExit(-1, String(e));
        return null;
    }
    let stdout = new Gio.DataInputStream({
        base_stream: proc.get_stdout_pipe(),
        close_base_stream: true,
    });

    const readNext = () => {
        stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
            let line = null;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (e) {
                onExit(-1, String(e));
                return;
            }
            if (line === null) {                       // EOF
                proc.wait_async(null, (pp, rr) => {
                    try { pp.wait_finish(rr); } catch (e) {}
                    onExit(pp.get_exit_status(), null);
                });
                return;
            }
            if (line.length)
                onLine(line);
            readNext();
        });
    };
    readNext();
    return proc;
}

function lastJsonLine(stdout) {
    if (!stdout) return null;
    let lines = stdout.split('\n').filter(l => l.trim().length);
    if (!lines.length) return null;
    try { return JSON.parse(lines[lines.length - 1]); }
    catch (e) { return null; }
}

/* ------------------------------------------------------------------ */
/* the panel button                                                    */
/* ------------------------------------------------------------------ */

const GanjoorIndicator = GObject.registerClass(
class GanjoorIndicator extends PanelMenu.Button {

    _init(settings) {
        super._init(0.0, 'Ganjoor Beyt');
        this._settings = settings;
        this._proc = null;         // running update process, if any
        this._tickId = 0;

        // panel icon
        this.add_child(new St.Icon({
            icon_name: 'accessories-dictionary-symbolic',
            style_class: 'system-status-icon',
        }));

        this._buildMenu();
        this._restoreCached();
        this._maybeRefresh();      // refresh if the interval has elapsed
        this._startTick();
    }

    /* ---- menu layout ---- */
    _buildMenu() {
        // display item (non-clickable) holding the beyt
        this._display = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'ganjoor-display',
        });
        let box = new St.BoxLayout({ vertical: true, x_expand: true });

        this._m1 = new St.Label({ style_class: 'ganjoor-mesra', text: '' });
        this._m2 = new St.Label({ style_class: 'ganjoor-mesra', text: '' });
        this._cap = new St.Label({ style_class: 'ganjoor-caption', text: '' });
        this._m1.clutter_text.line_wrap = true;
        this._m2.clutter_text.line_wrap = true;

        box.add_child(this._m1);
        box.add_child(this._m2);
        box.add_child(this._cap);
        this._display.add_child(box);
        this.menu.addMenuItem(this._display);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._newItem = new PopupMenu.PopupImageMenuItem(
            'بیتِ تازه', 'view-refresh-symbolic');
        this._newItem.connect('activate', () => this._pickNewBeyt());
        this.menu.addMenuItem(this._newItem);

        this._updItem = new PopupMenu.PopupImageMenuItem(
            'به‌روزرسانی دیتابیس (آنلاین)', 'folder-download-symbolic');
        this._updItem.connect('activate', () => this._startUpdate());
        this.menu.addMenuItem(this._updItem);

        // progress / status line (hidden until needed)
        this._status = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._status.label.style_class = 'ganjoor-status';
        this._status.visible = false;
        this.menu.addMenuItem(this._status);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let prefsItem = new PopupMenu.PopupImageMenuItem(
            'تنظیمات…', 'preferences-system-symbolic');
        prefsItem.connect('activate', () => ExtensionUtils.openPrefs());
        this.menu.addMenuItem(prefsItem);
    }

    _dbPath() {
        let p = this._settings.get_string('database-path');
        return (p && p.length) ? p : _defaultDbPath();
    }

    /* ---- showing a beyt ---- */
    _showBeyt(b) {
        if (!b) return;
        this._m1.text = b.m1 || '';
        this._m2.text = b.m2 || '';
        let cap = [];
        if (b.poet) cap.push(b.poet);
        if (b.title) cap.push(b.title);
        this._cap.text = cap.length ? '— ' + cap.join(' · ') : '';
    }

    _restoreCached() {
        let raw = this._settings.get_string('last-beyt');
        if (raw && raw.length) {
            try { this._showBeyt(JSON.parse(raw)); return; } catch (e) {}
        }
        this._m1.text = 'برای دیدن بیت، «بیتِ تازه» را بزنید.';
    }

    _selectedPoetsArg() {
        // schema key `selected-poets` is an array of poet-id strings.
        // Empty -> no argument -> helper picks from all poets.
        let ids = this._settings.get_strv('selected-poets');
        return (ids && ids.length) ? ids.join(',') : null;
    }

    _pickNewBeyt() {
        let py = _python();
        if (!py) { this._flash('python3 نصب نیست.'); return; }
        let db = this._dbPath();

        let argv = [py, HELPER, 'beyt', db];
        let poets = this._selectedPoetsArg();
        if (poets) argv.push(poets);

        this._newItem.label.text = 'در حال خواندن…';
        spawnCollect(argv, (out, err) => {
            this._newItem.label.text = 'بیتِ تازه';
            let r = lastJsonLine(out);
            if (r && r.ok) {
                this._showBeyt(r);
                this._settings.set_string('last-beyt', JSON.stringify({
                    poet: r.poet, title: r.title, m1: r.m1, m2: r.m2,
                }));
                this._settings.set_int64(
                    'last-refresh', GLib.DateTime.new_now_local().to_unix());
                if (this._settings.get_boolean('notify-on-new'))
                    this._notify(r);
            } else if (r && r.error === 'db_missing') {
                this._flash('دیتابیس یافت نشد — «به‌روزرسانی دیتابیس» را بزنید یا مسیرش را در تنظیمات بدهید.');
            } else if (r && r.error === 'no_verse_for_poets') {
                this._flash('از شاعرانِ انتخاب‌شده بیتی یافت نشد — انتخاب را در تنظیمات بازبینی کنید.');
            } else {
                this._flash('خطا در خواندن دیتابیس.');
            }
        });
    }

    _notify(r) {
        let body = (r.m1 || '') + '\n' + (r.m2 || '');
        let title = r.poet ? ('گنجور — ' + r.poet) : 'بیت گنجور';
        Main.notify(title, body);
    }

    /* ---- online update ---- */
    _startUpdate() {
        if (this._proc) return;                 // already running
        let py = _python();
        if (!py) { this._flash('python3 نصب نیست.'); return; }

        let db = this._dbPath();
        let api = this._settings.get_string('update-api-url');

        this._updItem.setSensitive(false);
        this._updItem.label.text = 'در حال به‌روزرسانی…';
        this._setStatus('در حال یافتن آخرین نسخه…');

        this._proc = spawnStream(
            [py, HELPER, 'update', db, api],
            (line) => {
                let o;
                try { o = JSON.parse(line); } catch (e) { return; }
                if (!o.ok) return;
                if (o.stage === 'lookup')   this._setStatus('در حال یافتن آخرین نسخه…');
                else if (o.stage === 'download' && 'progress' in o)
                    this._setStatus(`دانلود: ${o.progress}٪`);
                else if (o.stage === 'download')
                    this._setStatus('شروع دانلود…');
                else if (o.stage === 'extract')
                    this._setStatus('در حال استخراج فایل…');
                else if (o.stage === 'done')
                    this._setStatus('به‌روزرسانی کامل شد ✓' +
                        (o.tag ? ` (${o.tag})` : ''));
            },
            (exit, errmsg) => {
                this._proc = null;
                this._updItem.setSensitive(true);
                this._updItem.label.text = 'به‌روزرسانی دیتابیس (آنلاین)';
                if (exit === 0) {
                    // pick a beyt from the fresh database
                    this._pickNewBeyt();
                    this._hideStatusLater(4000);
                } else {
                    this._setStatus('به‌روزرسانی ناموفق بود.');
                    this._hideStatusLater(6000);
                }
            });
    }

    _setStatus(txt) {
        this._status.label.text = txt;
        this._status.visible = true;
    }

    _hideStatusLater(ms) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (this._status) this._status.visible = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _flash(txt) {
        this._setStatus(txt);
        this._hideStatusLater(6000);
    }

    /* ---- scheduling (daily / interval) ---- */
    _maybeRefresh() {
        let hours = this._settings.get_int('refresh-interval-hours');
        if (hours <= 0) return;
        let last = this._settings.get_int64('last-refresh');
        let now = GLib.DateTime.new_now_local().to_unix();
        if (now - last >= hours * 3600)
            this._pickNewBeyt();
    }

    _startTick() {
        // check twice an hour whether it is time for a new beyt
        this._tickId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1800, () => {
                this._maybeRefresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    destroy() {
        if (this._tickId) { GLib.source_remove(this._tickId); this._tickId = 0; }
        if (this._proc) { try { this._proc.force_exit(); } catch (e) {} this._proc = null; }
        super.destroy();
    }
});

/* ------------------------------------------------------------------ */
/* extension entry points (GNOME 42/43/44)                             */
/* ------------------------------------------------------------------ */

let _indicator = null;
let _settings = null;

function init() {
    // no translations bundled; nothing to initialize here
}

function enable() {
    _settings = ExtensionUtils.getSettings();
    _indicator = new GanjoorIndicator(_settings);
    Main.panel.addToStatusArea('ganjoor-beyt', _indicator);
}

function disable() {
    if (_indicator) { _indicator.destroy(); _indicator = null; }
    _settings = null;
}
