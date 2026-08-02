'use strict';

const { Adw, Gtk, Gio, GLib, GObject } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const HELPER = Me.path + '/ganjoor_helper.py';

function init() {}

function _python() {
    return GLib.find_program_in_path('python3') ||
           GLib.find_program_in_path('python');
}

function _defaultDbPath() {
    return GLib.build_filenamev(
        [GLib.get_user_data_dir(), 'ganjoor', 'ganjoor.s3db']);
}

// Run `ganjoor_helper.py poets <db>` and hand the parsed result to `cb`.
// cb(poets, errorCode) where poets is an array of {id, name, poems} or null.
function _loadPoets(db, cb) {
    const py = _python();
    if (!py) { cb(null, 'no_python'); return; }
    let proc;
    try {
        proc = Gio.Subprocess.new(
            [py, HELPER, 'poets', db],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        cb(null, 'spawn_failed');
        return;
    }
    proc.communicate_utf8_async(null, null, (p, res) => {
        let out = '';
        try { [, out] = p.communicate_utf8_finish(res); }
        catch (e) { cb(null, 'io_failed'); return; }
        let r = null;
        const lines = (out || '').split('\n').filter(l => l.trim());
        if (lines.length) {
            try { r = JSON.parse(lines[lines.length - 1]); } catch (e) {}
        }
        if (r && r.ok) cb(r.poets || [], null);
        else if (r && r.error) cb(null, r.error);
        else cb(null, 'bad_output');
    });
}

function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings();
    const page = new Adw.PreferencesPage();

    /* ---- database group ---- */
    const dbGroup = new Adw.PreferencesGroup({
        title: 'دیتابیس گنجور',
        description: 'اگر مسیر را خالی بگذارید، از ' + _defaultDbPath() +
                     ' استفاده می‌شود.',
    });
    page.add(dbGroup);

    const pathRow = new Adw.EntryRow({ title: 'مسیر فایل ganjoor.s3db' });
    settings.bind('database-path', pathRow, 'text',
        Gio.SettingsBindFlags.DEFAULT);

    const browseBtn = new Gtk.Button({
        icon_name: 'folder-open-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    browseBtn.connect('clicked', () => {
        const chooser = new Gtk.FileChooserNative({
            title: 'انتخاب فایل دیتابیس گنجور',
            transient_for: window,
            modal: true,
            action: Gtk.FileChooserAction.OPEN,
        });
        const filter = new Gtk.FileFilter();
        filter.set_name('دیتابیس SQLite');
        filter.add_pattern('*.s3db');
        filter.add_pattern('*.sqlite');
        filter.add_pattern('*.db');
        chooser.add_filter(filter);
        chooser.connect('response', (self, resp) => {
            if (resp === Gtk.ResponseType.ACCEPT) {
                const f = self.get_file();
                if (f) pathRow.text = f.get_path();
            }
            self.destroy();
        });
        chooser.show();
    });
    pathRow.add_suffix(browseBtn);
    dbGroup.add(pathRow);

    // "check database" row -> shows counts
    const infoRow = new Adw.ActionRow({
        title: 'وضعیت دیتابیس',
        subtitle: 'برای بررسی، دکمه را بزنید.',
    });
    const checkBtn = new Gtk.Button({
        label: 'بررسی',
        valign: Gtk.Align.CENTER,
    });
    checkBtn.connect('clicked', () => {
        const py = _python();
        if (!py) { infoRow.subtitle = 'python3 نصب نیست.'; return; }
        const db = pathRow.text && pathRow.text.length
            ? pathRow.text : _defaultDbPath();
        infoRow.subtitle = 'در حال بررسی…';
        try {
            const proc = Gio.Subprocess.new(
                [py, HELPER, 'info', db],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                let out = '';
                try { [, out] = p.communicate_utf8_finish(res); }
                catch (e) { infoRow.subtitle = 'خطا: ' + e; return; }
                let r = null;
                const lines = (out || '').split('\n').filter(l => l.trim());
                if (lines.length) { try { r = JSON.parse(lines[lines.length - 1]); } catch (e) {} }
                if (r && r.ok) {
                    infoRow.subtitle =
                        `${r.poets} شاعر · ${r.poems} شعر · ${r.verses} مصراع`;
                } else if (r && r.error === 'db_missing') {
                    infoRow.subtitle = 'فایل دیتابیس در این مسیر نیست.';
                } else {
                    infoRow.subtitle = 'دیتابیس معتبر نیست.';
                }
            });
        } catch (e) {
            infoRow.subtitle = 'خطا: ' + e;
        }
    });
    infoRow.add_suffix(checkBtn);
    dbGroup.add(infoRow);

    /* ---- behaviour group ---- */
    const behGroup = new Adw.PreferencesGroup({ title: 'رفتار' });
    page.add(behGroup);

    const intervalRow = new Adw.ActionRow({
        title: 'فاصلهٔ نمایش بیت تازه (ساعت)',
        subtitle: 'صفر یعنی فقط دستی. پیش‌فرض ۲۴ (روزانه).',
    });
    const spin = new Gtk.SpinButton({
        valign: Gtk.Align.CENTER,
        adjustment: new Gtk.Adjustment({
            lower: 0, upper: 720, step_increment: 1, page_increment: 6,
        }),
    });
    settings.bind('refresh-interval-hours', spin, 'value',
        Gio.SettingsBindFlags.DEFAULT);
    intervalRow.add_suffix(spin);
    intervalRow.activatable_widget = spin;
    behGroup.add(intervalRow);

    const notifyRow = new Adw.ActionRow({
        title: 'نمایش اعلان هنگام بیت تازه',
    });
    const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind('notify-on-new', sw, 'active',
        Gio.SettingsBindFlags.DEFAULT);
    notifyRow.add_suffix(sw);
    notifyRow.activatable_widget = sw;
    behGroup.add(notifyRow);

    /* ---- poets group ---- */
    const poetsGroup = new Adw.PreferencesGroup({
        title: 'شاعران',
        description: 'ابیات فقط از شاعرانِ انتخاب‌شده نمایش داده می‌شود. ' +
                     'اگر هیچ شاعری انتخاب نشود، از همهٔ شاعران استفاده می‌شود.',
    });
    page.add(poetsGroup);

    // header buttons: reload / select-all / select-none
    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        valign: Gtk.Align.CENTER,
    });
    const reloadBtn = new Gtk.Button({
        icon_name: 'view-refresh-symbolic',
        tooltip_text: 'بارگذاری دوبارهٔ فهرست شاعران',
        css_classes: ['flat'],
    });
    const allBtn  = new Gtk.Button({ label: 'همه',       css_classes: ['flat'] });
    const noneBtn = new Gtk.Button({ label: 'هیچ‌کدام', css_classes: ['flat'] });
    headerBox.append(reloadBtn);
    headerBox.append(allBtn);
    headerBox.append(noneBtn);
    poetsGroup.set_header_suffix(headerBox);

    // search box (added as the first child of the group)
    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: 'جست‌وجوی نام شاعر…',
        hexpand: true,
        margin_top: 6,
        margin_bottom: 6,
    });
    poetsGroup.add(searchEntry);

    // a status/placeholder row shown while loading or on error
    const poetsStatus = new Adw.ActionRow({ title: 'در حال بارگذاری…' });
    poetsGroup.add(poetsStatus);

    // in-memory selection set (strings, to match the `as` schema type)
    let selected = new Set(settings.get_strv('selected-poets'));
    let poetRows = [];   // { row, check, name }

    function persist() {
        settings.set_strv('selected-poets', [...selected]);
    }

    function clearPoetRows() {
        for (const pr of poetRows) poetsGroup.remove(pr.row);
        poetRows = [];
    }

    function applyFilter() {
        const q = searchEntry.text.trim();
        for (const pr of poetRows)
            pr.row.visible = q.length === 0 || pr.name.includes(q);
    }

    function setVisibleChecked(state) {
        for (const pr of poetRows) {
            if (!pr.row.visible) continue;
            if (pr.check.active !== state) pr.check.active = state; // fires toggled
        }
    }

    function buildPoetRows(poets) {
        clearPoetRows();
        // prune any selected ids that no longer exist in this database
        const existing = new Set(poets.map(p => String(p.id)));
        let pruned = false;
        for (const id of [...selected]) {
            if (!existing.has(id)) { selected.delete(id); pruned = true; }
        }
        if (pruned) persist();

        for (const p of poets) {
            const id = String(p.id);
            const row = new Adw.ActionRow({
                title: p.name || '(بی‌نام)',
                subtitle: `${p.poems} شعر`,
            });
            const check = new Gtk.CheckButton({
                valign: Gtk.Align.CENTER,
                active: selected.has(id),
            });
            check.connect('toggled', () => {
                if (check.active) selected.add(id);
                else selected.delete(id);
                persist();
            });
            row.add_prefix(check);
            row.activatable_widget = check;
            poetsGroup.add(row);
            poetRows.push({ row, check, name: p.name || '' });
        }
        applyFilter();
    }

    function refreshPoets() {
        clearPoetRows();
        poetsStatus.visible = true;
        poetsStatus.title = 'در حال بارگذاری…';
        const db = settings.get_string('database-path') || _defaultDbPath();
        _loadPoets(db, (poets, err) => {
            if (poets) {
                if (poets.length === 0) {
                    poetsStatus.title = 'شاعری در دیتابیس یافت نشد.';
                    poetsStatus.visible = true;
                } else {
                    poetsStatus.visible = false;
                    buildPoetRows(poets);
                }
            } else if (err === 'db_missing') {
                poetsStatus.title =
                    'دیتابیس یافت نشد — ابتدا آن را دریافت یا مسیرش را تنظیم کنید.';
                poetsStatus.visible = true;
            } else if (err === 'no_python') {
                poetsStatus.title = 'python3 نصب نیست.';
                poetsStatus.visible = true;
            } else {
                poetsStatus.title = 'خطا در خواندن فهرست شاعران.';
                poetsStatus.visible = true;
            }
        });
    }

    searchEntry.connect('search-changed', applyFilter);
    reloadBtn.connect('clicked', refreshPoets);
    allBtn.connect('clicked',  () => setVisibleChecked(true));
    noneBtn.connect('clicked', () => setVisibleChecked(false));

    // reload the list whenever the database path changes in settings
    const _poetsPathHandler = settings.connect(
        'changed::database-path', () => refreshPoets());
    poetsGroup.connect('destroy', () => {
        try { settings.disconnect(_poetsPathHandler); } catch (e) {}
    });

    refreshPoets();

    /* ---- source group ---- */
    const srcGroup = new Adw.PreferencesGroup({
        title: 'منبع به‌روزرسانی',
        description: 'دیتابیس از مخزن رسمی گنجور (ganjoor/desktop) در گیت‌هاب دریافت می‌شود.',
    });
    page.add(srcGroup);

    const apiRow = new Adw.EntryRow({ title: 'آدرس API آخرین نسخه' });
    settings.bind('update-api-url', apiRow, 'text',
        Gio.SettingsBindFlags.DEFAULT);
    srcGroup.add(apiRow);

    window.add(page);
    window.set_default_size(560, 620);
}
