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
