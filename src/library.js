import Gtk from 'gi://Gtk'
import Adw from 'gi://Adw'
import GObject from 'gi://GObject'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Gdk from 'gi://Gdk'
import GdkPixbuf from 'gi://GdkPixbuf'
import cairo from 'gi://cairo'
import { gettext as _ } from 'gettext'
import * as utils from './utils.js'
import * as format from './format.js'

const listDir = function* (path) {
    const dir = Gio.File.new_for_path(path)
    if (!GLib.file_test(path, GLib.FileTest.IS_DIR)) return null
    const children = dir.enumerate_children('standard::name,time::modified',
        Gio.FileQueryInfoFlags.NONE, null)
    let info
    while ((info = children.next_file(null)) != null) {
        try {
            const name = info.get_name()
            if (!/\.json$/.test(name)) continue
            const child = dir.get_child(name)
            yield {
                file: child,
                modified: new Date(info.get_attribute_uint64('time::modified') * 1000),
            }
        } catch (e) {
            continue
        }
    }
}

class URIStore {
    #storage = new utils.JSONStorage(pkg.datapath('library'), 'uri-store')
    #map = new Map(this.#storage.get('uris'))
    get(id) {
        return this.#map.get(id)
    }
    set(id, uri) {
        this.#map.set(id, uri)
        this.#storage.set('uris', Array.from(this.#map.entries()))
    }
    delete(id) {
        this.#map.delete(id)
        this.#storage.set('uris', Array.from(this.#map.entries()))
    }
}

const BookList = GObject.registerClass({
    GTypeName: 'FoliateBookList',
}, class extends Gio.ListStore {
    #uriStore = new URIStore()
    #files = Array.from(listDir(pkg.datadir) ?? [])
        .sort((a, b) => b.modified - a.modified)
        .map(x => x.file)
    #iter = this.#files.values()
    constructor(params) {
        super(params)
        this.readFile = utils.memoize(utils.readJSONFile)
        this.readCover = utils.memoize(identifier => {
            const path = pkg.cachepath(`${encodeURIComponent(identifier)}.png`)
            try { return GdkPixbuf.Pixbuf.new_from_file(path) }
            catch (e) { return null }
        })
    }
    loadMore(n) {
        for (let i = 0; i < n; i++) {
            const { value, done } = this.#iter.next()
            if (done) return true
            else this.append(value)
        }
    }
    getURI(identifier) {
        // TODO: use tracker
        return this.#uriStore.get(identifier)
    }
    delete(file) {
        const name = file.get_basename()
        const cover = Gio.File.new_for_path(pkg.cachepath(name.replace('.json', '.png')))
        const id = decodeURIComponent(name.replace('.json', ''))
        this.#uriStore.delete(id)
        for (const f of [file, cover]) try { f.delete(null) } catch {}
        for (const [i, el] of utils.gliter(this)) if (el === file) this.remove(i)
    }
})

const getBooks = utils.memoize(() => new BookList())

const width = 256
const height = width * 1.5
const surface = new cairo.ImageSurface(cairo.Format.ARGB32, width, height)
const defaultPixbuf = Gdk.pixbuf_get_from_surface(surface, 0, 0, width, height)

GObject.registerClass({
    GTypeName: 'FoliateBookImage',
    Template: pkg.moduleuri('ui/book-image.ui'),
    InternalChildren: ['image', 'generated', 'title'],
}, class extends Gtk.Overlay {
    load(pixbuf, title) {
        if (pixbuf) {
            this._generated.visible = false
            this._image.set_pixbuf(pixbuf)
            this._image.opacity = 1
        } else {
            this._image.set_pixbuf(defaultPixbuf)
            this._image.opacity = 0
            this._title.label = title
            this._generated.visible = true
        }
    }
})

const BookItem = GObject.registerClass({
    GTypeName: 'FoliateBookItem',
    Template: pkg.moduleuri('ui/book-item.ui'),
    InternalChildren: ['image', 'title', 'creator', 'box', 'progress'],
    Signals: {
        'remove-book': { param_types: [Gio.File.$gtype] },
    },
}, class extends Gtk.Box {
    #item
    constructor(params) {
        super(params)
        this.insert_action_group('book-item', utils.addSimpleActions({
            'remove': () => this.emit('remove-book', this.#item),
        }))
    }
    update(item, data) {
        this.#item = item
        const { cover, title, creator, progress, menu } = data
        this._title.label = title ?? ''
        this._creator.label = creator ?? ''
        this._title.margin_top = menu ? 0 : 6
        this._box.visible = !!menu
        this._progress.label = progress == null ? '' : format.percent(progress)
        this._image.load(cover?.then ? null : cover, title)
    }
})

const matchString = (x, q) => typeof x === 'string'
    ? x.toLowerCase().includes(q) : false

GObject.registerClass({
    GTypeName: 'FoliateLibraryView',
    Template: pkg.moduleuri('ui/library-view.ui'),
    InternalChildren: ['scrolled'],
    Signals: {
        'load-more': { return_type: GObject.TYPE_BOOLEAN },
        'load-all': {},
        'activate': { param_types: [GObject.TYPE_OBJECT] },
        'get-data': {
            param_types: [GObject.TYPE_OBJECT, GObject.TYPE_BOOLEAN],
            return_type: GObject.TYPE_JSOBJECT,
        },
    },
}, class extends Gtk.Stack {
    #done = false
    #filter = new Gtk.CustomFilter()
    #filterModel = utils.connect(new Gtk.FilterListModel({ filter: this.#filter }),
        { 'items-changed': () => this.#update() })
    constructor(params) {
        super(params)
        utils.connect(this._scrolled.vadjustment, {
            'changed': this.#checkAdjustment.bind(this),
            'value-changed': this.#checkAdjustment.bind(this),
        })
    }
    #checkAdjustment(adj) {
        if (this.#done) return
        if (adj.value + adj.page_size * 1.5 >= adj.upper) {
            const done = this.emit('load-more')
            if (done) this.#done = true
            else utils.wait(10).then(() => this.#checkAdjustment(adj))
        }
    }
    #update() {
        this.visible_child_name = !this.#filterModel.model.get_n_items() ? 'empty'
            : !this.#filterModel.get_n_items() ? 'no-results' : 'main'
    }
    setModel(model) {
        this.#filterModel.model = model
        this.#update()
    }
    showGrid() {
        this._scrolled.child?.unparent()
        const showCover = true
        this._scrolled.child = utils.connect(new Gtk.GridView({
            single_click_activate: true,
            max_columns: 20,
            vscroll_policy: Gtk.ScrollablePolicy.NATURAL,
            model: new Gtk.NoSelection({ model: this.#filterModel }),
            factory: utils.connect(new Gtk.SignalListItemFactory(), {
                'setup': (_, item) => item.child = utils.connect(new BookItem(), {
                    'remove-book': (_, file) => this.removeBook(file),
                }),
                'bind': (_, { child, item }) => {
                    const data = this.emit('get-data', item, showCover)
                    child.update(item, data)
                    if (data?.cover?.then) data.cover
                        .then(cover => child.update({ ...data, cover }))
                        .catch(e => console.warn(e))
                },
            }),
        }), { 'activate': (_, pos) =>
            this.emit('activate', this.#filterModel.get_item(pos)) })
    }
    /*
    showList() {
        this._scrolled.child?.unparent()
        this._scrolled.child = new Adw.ClampScrollable({
            child: utils.connect(new Gtk.ListView({
                single_click_activate: true,
                model: new Gtk.NoSelection({ model: this.#filterModel }),
                factory: utils.connect(new Gtk.SignalListItemFactory(), {
                    'setup': (_, item) => item.child = new BookRow(),
                    'bind': (_, { child, item }) =>
                        child.update(this.emit('get-data', item, false)),
                }),
            }),  { 'activate': (_, pos) =>
                this.emit('activate', this.#filterModel.get_item(pos)) }),
        })
    }
    */
    search(text) {
        const q = text.trim().toLowerCase()
        if (!q) {
            this.#filter.set_filter_func(null)
            return
        }
        this.emit('load-all')
        const fields = ['title', 'creator', 'description']
        const { readFile } = this.#filterModel.model
        this.#filter.set_filter_func(file => {
            const { metadata } = readFile(file)
            if (!metadata) return false
            return fields.some(field => matchString(metadata[field], q))
        })
    }
    removeBook(file) {
        const dialog = new Adw.MessageDialog({
            transient_for: this.get_root(),
            modal: true,
            heading: _('Remove Book?'),
            body: _('Reading progress, annotations, and bookmarks will be permanently lost'),
        })
        dialog.add_response('cancel', _('_Cancel'))
        dialog.add_response('remove', _('_Remove'))
        dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.present()
        dialog.connect('response', (_, response) => {
            if (response === 'remove') getBooks().delete(file)
        })
    }
})

export const Library = GObject.registerClass({
    GTypeName: 'FoliateLibrary',
    Template: pkg.moduleuri('ui/library.ui'),
    InternalChildren: [
        'books-view', 'search-bar', 'search-entry',
    ],
}, class extends Gtk.Box {
    constructor(params) {
        super(params)
        const books = getBooks()

        utils.connect(this._books_view, {
            'activate': (_, item) => {
                const { identifier } = books.readFile(item)?.metadata ?? {}
                const uri = books.getURI(identifier)
                this.root.openFile(Gio.File.new_for_uri(uri))
            },
            'load-more': () => books.loadMore(1),
            'load-all': () => books.loadMore(Infinity),
            'get-data': (_, file, showCover) => {
                const data = books.readFile(file)
                const identifier = data?.metadata?.identifier
                const cover = showCover && identifier
                    ? books.readCover(identifier) : null
                const title = data?.metadata?.title
                const creator = data?.metadata?.creator
                const p = data?.progress
                const progress = p?.[1] ? (p[0] + 1) / (p[1] + 1) : null
                return { cover, title, creator, progress, menu: true }
            },
        })
        this._books_view.setModel(books)
        this._books_view.showGrid()
        books.loadMore(10)

        this._search_bar.connect_entry(this._search_entry)
        this._search_entry.connect('search-changed', entry =>
            this._books_view.search(entry.text))
    }
})
