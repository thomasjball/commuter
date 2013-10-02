// XXX Show test code for test cases.

// Default order for calls
var CALL_SEQ = [
    'open', 'link', 'unlink', 'rename', 'stat',
    'fstat', 'lseek', 'close', 'pipe', 'read', 'write', 'pread', 'pwrite',
    'mmap', 'munmap', 'mprotect', 'memread', 'memwrite'];

//
// Reactive rendezvous
//

function Rendezvous(value) {
    this.value = value;
    this.reactives = [];
}

Rendezvous.prototype.get = function(reactive) {
    if (reactive._re_version === undefined)
        reactive._re_version = 0;
    this.reactives.push({version:reactive._re_version, obj:reactive});
    return this.value;
};

Rendezvous.prototype.set = function(value) {
    if (value === this.value)
        return;
    this.value = value;
    var re = this.reactives;
    this.reactives = [];
    for (var i = 0; i < re.length; i++) {
        if (re[i].obj._re_version === re[i].version) {
            ++re[i].obj._re_version;
            re[i].obj.refresh();
        }
    }
};

//
// Utilities
//

// Compare two calls
function compareCalls(call1, call2) {
    var i1 = CALL_SEQ.indexOf(call1), i2 = CALL_SEQ.indexOf(call2);
    if (i1 === -1) i1 = CALL_SEQ.length;
    if (i2 === -1) i2 = CALL_SEQ.length;
    if (i1 === i2)
        return call1 < call2 ? -1 : (call1 > call2 ? 1 : 0);
    return i1 - i2;
}

// Split callSeq into array of calls in canonical order
function splitCallSeq(callSeq) {
    var parts = callSeq.split('_');
    parts.sort(compareCalls);
    return parts;
}

// Compare two call sequences
function compareCallSeqs(cs1, cs2) {
    if (cs1 === cs2)
        return 0;
    var s1 = splitCallSeq(cs1), s2 = splitCallSeq(cs2);
    for (var i = 0; i < Math.min(s1.length, s2.length); i++)
        if (s1[i] !== s2[i])
            return compareCalls(s1[i], s2[i]);
    return s1.length - s2.length;
}

//
// Mscan database
//

function Database() {
    this.outputRv = new Rendezvous(Enumerable.empty());
    this.sources = [];
    this.data = [];
    this.byid = {};
}

Database.prototype.loadMscan = function(uri) {
    if (this.sources.indexOf(uri) != -1)
        // XXX Should return false if we're still loading this URI
        return true;
    this.sources.push(uri);

    // XXX Error handling, load indicator, clean up
    var dbthis = this;
    $.getJSON(uri).
        done(function(json) {
            console.log('Loaded', uri);
            dbthis.add(Database.mscanFromJSON(json));
        });
    return false;
};

Database.prototype.add = function(recs) {
    // Full outer join recs with this.data on 'id'
    for (var i = 0; i < recs.length; i++) {
        var rec = recs[i];
        var pre = this.byid[rec.id];
        if (pre === undefined) {
            this.data.push(rec);
            this.byid[rec.id] = rec;
        } else {
            for (var f in rec)
                if (rec.hasOwnProperty(f))
                    pre[f] = rec[f];
        }
    }

    // Sort data
    function cmp(a, b) {
        return a < b ? -1 : (a > b ? 1 : 0);
    }
    this.data.sort(function(a, b) {
        return compareCallSeqs(a.calls, b.calls) || cmp(a.pathid, b.pathid) ||
            cmp(a.testno, b.testno) || cmp(a.runid, b.runid);
    });

    this.outputRv.set(Enumerable.from(this.data));
};

Database.mscanFromJSON = function(json) {
    // Reverse table-ification
    function untablify(table) {
        var fields = table['!fields'];
        var data = table['!data'];
        if (fields === undefined || data === undefined)
            return table;

        var out = [];
        var prev = {};
        var weight = [];
        for (var i = 0; i < data.length; i++) {
            var deltamask = data[i][0];

            // Get or compute weight of deltamask
            var dw = weight[deltamask];
            if (dw === undefined) {
                dw = 0;
                for (var j = 0; j < fields.length; j++)
                    if (deltamask & (1 << j))
                        ++dw;
                weight[deltamask] = dw;
            }

            // Get initial object
            var obj = data[i][dw + 1] || {};

            // Fill fields
            var deltapos = 1;
            for (var j = 0; j < fields.length; j++) {
                if (deltamask & (1 << j))
                    obj[fields[j]] = data[i][deltapos++];
                else
                    obj[fields[j]] = prev[fields[j]];
            }

            out.push(obj);
            prev = obj;
        }
        return out;
    }

    // Reverse deduplication of stacks
    var stackkeys = ['stack', 'stack1', 'stack2'];
    function getStacks(testcases, stacks) {
        if (stacks === undefined)
            return testcases;
        for (var tci = 0; tci < testcases.length; tci++) {
            var testcase = testcases[tci];
            for (var si = 0; si < testcase.shared.length; si++) {
                for (var ki = 0; ki < stackkeys.length; ki++) {
                    var k = stackkeys[ki];
                    var shared = testcase.shared[si];
                    if (shared[k] === undefined)
                        continue;
                    shared[k] = json.stacks[shared[k]];
                }
            }
        }
        return testcases;
    }

    // Put name components back together and handle 'nshared'
    function reformat(testcases) {
        for (var i = 0; i < testcases.length; i++) {
            var testcase = testcases[i];
            testcase.path = testcase.calls + '_' + testcase.pathid;
            testcase.test = testcase.path + '_' + testcase.testno;
            testcase.id = testcase.test + '_' + testcase.runid;
            if (testcase.nshared !== undefined) {
                testcase.shared = new Array(testcase.nshared);
                delete testcase.nshared;
            }
        }
        return testcases;
    }

    return reformat(getStacks(untablify(json.testcases), json.stacks));
};

//
// Query canvas
//

function QueryCanvas(parent, inputRv) {
    this.inputRv = this.curRv = inputRv;
    this.container = $('<div>').appendTo(parent);
}

QueryCanvas.prototype.heatmap = function(pred, facets) {
    var hm = new Heatmap(this.curRv, pred, facets);
    this.container.append(hm.elt.css('margin-bottom', '10px'));
    this.curRv = hm.outputRv;
    return this;
};

QueryCanvas.prototype.table = function(detailFn) {
    var t = new Table(this.curRv, detailFn);
    this.container.append(t.elt.css('margin-bottom', '10px'));
    this.curRv = t.outputRv;
    return this;
};

//
// Heatmap
//

function hsv2css(h, s, v) {
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }
    return 'rgb(' + Math.floor(r * 255) + ',' + Math.floor(g * 255) + ',' +
        Math.floor(b * 255) + ')';
}

function inter(a, b, v) {
    return a * (1 - v) + b * v;
}

function Heatmap(inputRv, pred, facets) {
    this.inputRv = inputRv;
    this.pred = pred;
    this.facets = facets || function () { return ''; };
    this.color = function (frac) {
        if (frac == 0)
            return hsv2css(0.34065, 1, 0.91);
        return hsv2css(inter(0.34065, 0,   0.5 + frac / 2),
                       inter(1,       0.8, 0.5 + frac / 2),
                       inter(0.91,    1,   0.5 + frac / 2));
    };

    this.elt = $('<div>').css({textAlign: 'center'});
    this.selection = {};
    this.outputRv = new Rendezvous();
    this.refresh();
}

// Heatmap constants
Heatmap.FONT = '14px sans-serif';
Heatmap.CW = 16;
Heatmap.CH = 16;
Heatmap.PAD = Heatmap.CW / 2;

Heatmap.prototype.refresh = function() {
    var hmthis = this;
    this.elt.empty();
    var input = this.inputRv.get(this);

    // Get all calls, ordered by CALL_SEQ, then alphabetically.
    // XXX Maybe this shouldn't be symmetric.  For example, if my
    // input is for just one call set X_Y, then I shouldn't list both
    // X and Y on both the rows and columns.
    var calls = input.
        selectMany(function (testcase) { return testcase.calls.split('_'); }).
        distinct().
        orderBy(function (name) {
            var idx = CALL_SEQ.indexOf(name);
            if (idx >= 0)
                return '\x00' + String.fromCharCode(idx);
            return name;
        }).toArray();

    // Split input into facets
    var facets = 
        input.groupBy(this.facets, null, function (fLabel, testcases) {
            return {
                label: fLabel,
                // Split facet into cells
                cells: testcases.groupBy(
                    function (testcase) {  return testcase.calls; }, null,
                    function (tcCalls, testcases) {
                        // Compute cell location
                        var cellCalls = tcCalls.split('_');
                        var c1 = calls.indexOf(cellCalls[0]);
                        var c2 = calls.indexOf(cellCalls[1]);
                        if (c1 <= c2)
                            var x = calls.length - c2 - 1, y = c1;
                        else
                            var x = calls.length - c1 - 1, y = c2;

                        // Aggregate cell information
                        return testcases.aggregate(
                            {x:x, y:y, testcases:testcases,
                             total: 0, matched: 0},
                            function (sum, testcase) {
                                ++sum.total;
                                if (hmthis.pred(testcase))
                                    ++sum.matched;
                                return sum;
                            });
                    }).memoize()
            };
        }).memoize();

    // Create canvases, update selection, and do initial renders
    var foundSelection = false;
    this._maxLabel = 0;
    facets.forEach(function (facet) {
        // Create canvas
        var div = $('<div>').css({display: 'inline-block'}).
            appendTo(hmthis.elt);
        var canvas = $('<canvas>').appendTo(div);

        // Activate canvas
        canvas.mousemove(function (ev) {
            var offset = canvas.offset();
            var x = ev.pageX - offset.left, y = ev.pageY - offset.top;
            hmthis._render(facet, hmthis._coordToCell(facet, x, y));
        });
        canvas.mouseout(function () {
            hmthis._render(facet, {});
        });
        canvas.click(function (ev) {
            // XXX Support selecting a whole call, too
            var offset = canvas.offset();
            var x = ev.pageX - offset.left, y = ev.pageY - offset.top;
            var oldFacet = hmthis.selection.facet;
            hmthis.selection = hmthis._coordToCell(facet, x, y);
            hmthis._render(facet, hmthis.selection);
            // Clear previous selection
            if (oldFacet && hmthis.selection.facet !== oldFacet)
                hmthis._render(oldFacet, {});

            // Update output for new selection
            hmthis._setOutput(input);
        });

        // Label canvas
        var label = $('<div>').css({textAlign: 'center'}).text(facet.label).
            appendTo(div);

        // Keep selection across refreshes if possible
        if (!foundSelection && hmthis.selection.facet &&
            hmthis.selection.facet.label === facet.label) {
            foundSelection = true;
            hmthis.selection.facet = facet;
        }

        // Set up facet object
        facet.calls = calls;
        facet.canvas = canvas[0];
        facet.labelDiv = label;
        hmthis._render(facet, {});
    });
    if (!foundSelection)
        this.selection = {};

    // Set up output
    this._setOutput(input);
};

Heatmap.prototype._coordToCell = function(facet, x, y) {
    var cx = Math.floor((x - facet.startX) / Heatmap.CW);
    var cy = Math.floor((y - facet.startY) / Heatmap.CH);
    if (cx < 0 || cy < 0 || cy > facet.calls.length - cx - 1)
        return {};
    return {facet:facet, x:cx, y:cy};
};

Heatmap.prototype._render = function(facet, hover) {
    var CW = Heatmap.CW, CH = Heatmap.CH, PAD = Heatmap.PAD;

    var hmthis = this;
    var calls = facet.calls;
    var ctx = facet.canvas.getContext('2d');

    // Measure labels
    if (this._maxLabel === 0) {
        ctx.font = Heatmap.FONT;
        for (var i = 0; i < calls.length; i++)
            this._maxLabel = Math.max(this._maxLabel,
                                      ctx.measureText(calls[i]).width);
    }
    var maxLabel = this._maxLabel;

    // Size (and clear) canvas
    var startX = maxLabel + PAD, startY = maxLabel + PAD;
    facet.startX = startX;
    facet.startY = startY;
    facet.canvas.width = startX + CW * calls.length + 5;
    facet.canvas.height = startY + CH * calls.length + 5;
    ctx.font = Heatmap.FONT;

    // Tweak facet label layout
    facet.labelDiv.css({paddingLeft: startX, width: CW * calls.length});

    // Labels
    ctx.save();
    ctx.textBaseline = 'middle'
    ctx.save();
    ctx.rotate(-Math.PI / 2);
    for (var i = 0; i < calls.length; i++) {
        if (i === hover.x)
            ctx.fillStyle = '#428bca';
        else
            ctx.fillStyle = 'black';
        ctx.fillText(calls[calls.length - i - 1],
                     -maxLabel, startX + i * CW + 0.5 * CW);
    }
    ctx.restore();
    ctx.textAlign = 'end';
    for (var i = 0; i < calls.length; i++) {
        if (i === hover.y)
            ctx.fillStyle = '#428bca';
        else
            ctx.fillStyle = 'black';
        ctx.fillText(calls[i], startX - PAD, startY + i * CH + 0.5 * CH);
    }
    ctx.restore();

    // Draw cells
    ctx.save();
    ctx.translate(startX, startY);

    // Gray "unknown" background
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (var i = 0; i < calls.length; i++) {
        ctx.lineTo(CW * (calls.length - i), i * CH);
        ctx.lineTo(CW * (calls.length - i), (i + 1) * CH);
    }
    ctx.lineTo(0, calls.length * CH);
    ctx.fillStyle = "#ccc";
    ctx.shadowOffsetX = ctx.shadowOffsetY = 3;
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'rgba(128,128,128,0.5)';
    ctx.fill();
    ctx.restore();

    // Known cells
    var clabels = [];
    facet.cells.forEach(function (cell) {
        ctx.fillStyle = hmthis.color(cell.matched / cell.total);
        ctx.fillRect(cell.x * CW, cell.y * CH, CW, CH);
        if (cell.matched > 0)
            clabels.push({x:cell.x, y:cell.y,
                          label:cell.matched.toString()});
    });

    // Hover
    if (hover.facet === facet) {
        ctx.save();
        ctx.strokeStyle = '#428bca';
        ctx.lineWidth = 2;
        ctx.strokeRect(hover.x * CW, hover.y * CH, CW, CH);
        ctx.restore();
    }

    // Selection
    if (this.selection.facet === facet) {
        ctx.save();
        ctx.strokeStyle = 'rgb(0,0,255)';
        ctx.lineWidth = 2;
        ctx.strokeRect(this.selection.x * CW, this.selection.y * CH, CW, CH);
        ctx.restore();
    }

    // Cell labels
    // XXX Maybe this should only be shown on hover?  Could show
    // both total and matched.
    ctx.fillStyle = 'black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '7pt sans-serif';
    for (var i = 0; i < clabels.length; i++) {
        var cl = clabels[i];
        ctx.fillText(cl.label, (cl.x + 0.5) * CW, (cl.y + 0.5) * CH);
    }

    ctx.restore();

    // Mouse cursor
    $(facet.canvas).css({cursor: hover.facet === facet ? 'pointer' : 'auto'});
};

Heatmap.prototype._setOutput = function(input) {
    // Refresh output based on selection
    if (!this.selection.facet) {
        // Select everything by default
        this.outputRv.set(input);
        return;
    }
    // XXX Only matched test cases, or all test cases for
    // this cell?  Since we don't display anything useful
    // for non-shared test cases right now, we only return
    // matched test cases.
    var hmthis = this;
    this.outputRv.set(this.selection.facet.cells.selectMany(function(cell) {
        if (cell.x === hmthis.selection.x && cell.y === hmthis.selection.y)
            return cell.testcases.where(hmthis.pred);
        return [];
    }));
};


//
// Table UI
//

function Table(inputRv, detailFn) {
    this.inputRv = inputRv;
    this.detailFn = detailFn || function () {};

    this.elt = $('<div>').addClass('datatable-wrapper');
    this.table = $('<table>').addClass('datatable').appendTo(this.elt);
    this.outputRv = new Rendezvous();
    this.limit = 10;
    this.refresh();
}

Table.INCREMENT = 100;
Table.COL_ORDER = ['calls', 'path', 'test', 'id', 'shared'];
Table.HIDE = ['runid', 'pathid', 'testno'];
Table.FORMATTERS = {
    shared: function(val) {
        if (!$.isArray(val))
            return;
        if (val.length === 0)
            return $('<td>0 addrs</td>');
        return $('<td style="color:#c00">').text(val.length + ' addrs');
    },
    path: function(val) {
        var parts = val.split('_');
        var pathid = parts[parts.length - 1];
        return $('<td><span style="color:#888">...</span></td>').append(pathid);
    },
    test: function(val) {
        var parts = val.split('_');
        var testid = parts[parts.length - 1];
        return $('<td><span style="color:#888">...</span></td>').append(testid);
    },
    id: function(val) {
        var parts = val.split('_');
        var testid = parts[parts.length - 1];
        return $('<td><span style="color:#888">...</span></td>').append(testid);
    },
};
Table.NA = $('<td style="color:#ccc">NA</td>');
Table.fmtCell = function(row, colname) {
    var val = row[colname];
    var res = undefined;
    if (colname in Table.FORMATTERS) {
        try {
            res = Table.FORMATTERS[colname](val);
        } catch (e) {
            console.log('Formatter failed:', e);
        }
    }
    if (res === undefined) {
        if (val === undefined) {
            res = Table.NA.clone();
        } else if (typeof val === 'string') {
            res = $('<td>').text(val);
        } else {
            var text = JSON.stringify(val);
            if (text.length > 32)
                text = text.substring(0, 32) + '...';
            res = $('<td>').text(text);
        }
    }
    res.css({borderTop: '1px solid #ccc'});
    return res;
};

Table.prototype.refresh = function() {
    var input = this.inputRv.get(this);
    this._render(input);
    this.outputRv.set(input);
};

Table.prototype._render = function(input) {
    var tthis = this;
    var table = this.table;

    // Save expanded rows
    var expanded = {};
    $('tr', table).each(function () {
        var info = $(this).data('table-info');
        if (info && info.is(':visible'))
            expanded[$(this).data('table-rec').id] = true;
    });

    // Clear table
    table.empty();

    // Collect columns
    var cols = [], colSet = {};
    input.take(tthis.limit).forEach(function(rec) {
        // XXX Descend into object fields
        $.each(rec, function(colname) {
            if (Table.HIDE.indexOf(colname) === -1 && !colSet[colname]) {
                colSet[colname] = true;
                cols.push(colname);
            }
        });
    });

    // Sort columns
    cols.sort(function (a, b) {
        var ai = Table.COL_ORDER.indexOf(a), bi = Table.COL_ORDER.indexOf(b);
        if (ai === -1) ai = Table.COL_ORDER.length;
        if (bi === -1) bi = Table.COL_ORDER.length;
        if (ai === bi)
            return a === b ? 0 : (a < b ? -1 : 1);
        return ai - bi;
    });

    // Create table header
    var th = $('<tr>').appendTo($('<thead>').appendTo(table));
    $.each(cols, function () {
        th.append($('<th>').text(this).css({width: (100 / cols.length) + '%'}));
    });

    // Create table rows
    var prev = {};
    input.forEach(function(rec, index) {
        if (index == tthis.limit) {
            // Reached limit; add table expander
            table.append(
                $('<tr>').addClass('datatable-more').append(
                    $('<td>').attr({colspan: cols.length}).
                        text((input.count() - index) + ' more...')).
                    click(function() {
                        if (tthis.limit < Table.INCREMENT)
                            tthis.limit = 0;
                        tthis.limit += Table.INCREMENT;
                        tthis._render(input);
                    }));
            return false;
        }

        var tr = $('<tr>').addClass('datatable-row').appendTo(table);
        tr.data('table-rec', rec);

        // Create cells
        for (var i = 0; i < cols.length; i++) {
            var colname = cols[i];
            if (prev[colname] === rec[colname]) {
                tr.append($('<td>'));
            } else {
                prev = {};
                tr.append(Table.fmtCell(rec, colname));
            }
        }
        prev = rec;

        // Make row clickable
        tr.click(function() {
            if (!tr.data('table-info'))
                tthis._addDetail(tr, cols.length).hide();
            tr.data('table-info').slideToggle();
        });

        // Expand if previously expanded
        if (expanded[rec.id])
            tthis._addDetail(tr, cols.length);
    });
};

Table.prototype._addDetail = function(tr, ncols) {
    var ntr = $('<tr>').addClass('datatable-info'), div;
    ntr.append($('<td>').attr({colspan: ncols}).append(div = $('<div>')));
    tr.after(ntr).data('table-info', div);

    var rec = tr.data('table-rec');
    var detail = this.detailFn(rec);
    if (detail === undefined)
        detail = ($('<pre>').css({font: 'inherit', whiteSpace: 'pre-wrap'}).
                  text(JSON.stringify(rec, null, '  ')));
    div.append(detail);
    return div;
};

//
// Setup
//

var database = new Database();

$(document).ready(function() {
    var qc = new QueryCanvas($('#container'), database.outputRv);
    qc.heatmap(function(tc) { return tc.shared.length; },
               function(tc) { return tc.runid; });
    qc.table(function(tc) {
        // Lazy load detail databases
        if (!database.loadMscan('data/sv6-details.json') ||
            !database.loadMscan('data/linux-details.json'))
            return $('<span>').text('Loading details...');
    });

    database.loadMscan('data/sv6.json');
    database.loadMscan('data/linux.json');
});