// var urlPort = "192.168.10.175:5000"
// // Pre-fetch data using ajax
// var boundary = $.ajax({
//     url: `http://${urlPort}/static/gis/panay_bound.geojson`,
//     dataType: "json",
//     success: console.log("RB data fetched."),
//     error: function (xhr) {
//         alert(xhr.statusText)
//     }
// })
var boundary = $.getJSON('static/gis/panay_bound.geojson');
// canvas on which all the flowing lines will be drawn, and some convenience variables
var flowCanvas = document.createElement('canvas');
flowCanvas.id = 'flow';
var flowContext;
var flowImageData;
var flowData;

// invisible canvas to which Mapzen elevation tiles will be drawn so we can calculate stuff
var demCanvas = document.createElement('canvas');
var demContext;
var demImageData;
var demData;

// not too big or this can get hella slow
var width = window.innerWidth;
var height = window.innerHeight;
document.getElementById('map').style.width = width + 'px';
document.getElementById('map').style.height = height + 'px';

flowCanvas.width = width;
flowCanvas.height = height;
demCanvas.width = width;
demCanvas.height = height;

flowContext = flowCanvas.getContext('2d');
demContext = demCanvas.getContext('2d');

flowContext.strokeStyle = 'rgba(0,150,200,.4)';
flowContext.lineWidth = 2;
flowContext.fillStlye = '#fff'; // fill is used for fading; apparently the color doesn't matter

var data = [];

// timeout/interval variables
var wait;
var seed;
var flowInterval;

// will hold the coordinates of current paths
var paths;

var dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
});

// var terrain = L.tileLayer('https://stamen-tiles-{s}.a.ssl.fastly.net/terrain-background/{z}/{x}/{y}.{ext}', {
//     attribution: 'Map tiles by <a href="http://stamen.com">Stamen Design</a>, <a href="http://creativecommons.org/licenses/by/3.0">CC BY 3.0</a> &mdash; Map data &copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
//     subdomains: 'abcd',
//     ext: 'png',
//     //   opacity: 0
// });
var terrain = L.esri.basemapLayer('ShadedRelief');
$.when(boundary).done(function () {
    console.log(boundary.responseJSON);
    var map = L.map('map', {
        center: [11.3209, 122.5373],
        zoom: 10,
        layers: [terrain,]
    });

    var baseMaps = {
        "Terrain": terrain,
        "Flat": dark
    };

    L.control.layers(baseMaps).addTo(map);

    // add geojson
    console.log(boundary.responseJSON);
    L.geoJSON(boundary.responseJSON).addTo(map);


    map.on('moveend', function () {
        // on move end we redraw the flow layer, so clear some stuff
        clearInterval(flowInterval);
        clearInterval(seed);
        flowContext.clearRect(0, 0, width, height);
        clearTimeout(wait);
        wait = setTimeout(getRelief, 500);  // redraw after a delay in case map is moved again soon after
        document.getElementById('drawing').style.display = 'block';
    });

    map.on('move', function () {
        // stop things so it doesn't redraw in the middle of panning
        clearTimeout(wait);
        document.getElementById('drawing').style.display = 'none';
    });

    // custom tile layer for the Mapzen elevation tiles
    // it returns div tiles but doesn't display anyting; images are saved but only drawn to an invisible canvas (demCanvas)
    var CanvasLayer = L.GridLayer.extend({
        createTile: function (coords) {
            var tile = L.DomUtil.create('div', 'leaflet-tile');
            var img = new Image();
            var self = this;
            img.crossOrigin = '';
            tile.img = img;
            img.onload = function () {
                // we wait for tile images to load before we can redraw the map
                clearTimeout(wait);
                wait = setTimeout(getRelief, 500); // only draw after a reasonable delay, so that we don't redraw on every single tile load
            }
            img.src = 'http://elevation-tiles-prod.s3.amazonaws.com/terrarium/' + coords.z + '/' + coords.x + '/' + coords.y + '.png'
            return tile;
        }
    });
    var demLayer = new CanvasLayer().addTo(map);

    // custom map pane for the flows, above other layers
    var pane = map.createPane('flow');
    pane.appendChild(flowCanvas);

    // this resets our canvas back to top left of the window after panning the map
    // Mapzen layers do this internally; need it for the custom flow canvas layer
    function reverseTransform() {
        var top_left = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(flowCanvas, top_left);
    };

    function getRelief() {
        // halt any running stuff
        clearInterval(seed);
        clearInterval(flowInterval);

        // reset canvases
        flowContext.clearRect(0, 0, width, height);
        demContext.clearRect(0, 0, width, height);
        reverseTransform();

        // reset DEM data by drawing elevation tiles to it
        data = [];
        for (var t in demLayer._tiles) {
            var rect = demLayer._tiles[t].el.getBoundingClientRect();
            demContext.drawImage(demLayer._tiles[t].el.img, rect.left, rect.top);
        }
        demImageData = demContext.getImageData(0, 0, width, height);
        demData = demImageData.data;

        // clear out previous paths
        paths = [];

        // create about 10K paths from random starting locations
        // staggered so they don't all start at the same time; a distracting pulsing effect tends to happen otherwise
        var i = 0;
        seed = setInterval(function () {
            // do 50 at a time
            var n = 50; while (n--) {
                var rx = parseInt(Math.random() * width);
                var ry = parseInt(Math.random() * height);
                var path = createPath([rx, ry]);
                if (path) {
                    paths.push(path);
                    i++;
                }
            }
            if (paths.length >= 10000) clearInterval(seed);
        }, 20);
        drawFlows();
    }

    // for a given location, get the next lowest adjacent locaiton, i.e. where a flow would go from here
    function getDataAtPoint(n, x, y) {
        if (elev(n, demData) < 1) {
            return;
        }

        var centerValue = elev(n, demData);

        /*
        look at nearby locations for the next lowest elevation, but not adjacent pixels
        going 3 or 4 pixels out, and also avoiding exact 45 degree angles, makes for a smoother look
      
        looking at the spots labeled X below. O is the current point
      
        - - - X X X - - -
        - - X - - - X - -
        - X - - - - - X -
        X - - - - - - - X
        X - - - O - - - X
        X - - - - - - - X
        - X - - - - - X -
        - - X - - - X - -
        - - - X X X - - -
        */

        var nearby = [
            [-1, -4],
            [-1, 4],
            [0, -4], // top, 2
            [0, 4],  // bottom, 3
            [1, -4],
            [1, 4],
            [-2, -3],  //topleft, 6
            [-2, 3], // bottomleft, 7
            [2, -3], // topright, 8
            [2, 3],  // bottomright, 9
            [-3, -2], // topleft, 10
            [-3, 2], //bottomleft, 11
            [3, -2], // topright, 12
            [3, 2], // bottomright, 13
            [-4, -1],
            [-4, 0], // left, 15
            [-4, 1],
            [4, -1],
            [4, 0],  // right, 18
            [4, 1]
        ];

        var edge = false;
        var min = Infinity;
        var minVal;

        for (var c = 0; c < nearby.length; c++) {
            index = getIndexForCoordinates(width, x + nearby[c][0], y + nearby[c][1]);
            var e = elev(index, demData);
            var val = [x + nearby[c][0], y + nearby[c][1], e];
            if (e !== undefined) {
                min = Math.min(min, e);
                if (e == min) minVal = val;
            }
            // rough check whether the trend is off screen; we'll stop here if so
            // avoids paths taking a sharp turn and running down the edge of the screen
            if (x == 0 && c == 18 && e > centerValue) edge = true;
            if (y == 0 && c == 3 && e > centerValue) edge = true;
            if (x == width - 1 && c == 15 && e > centerValue) edge = true;
            if (y == height - 1 && c == 2 && e > centerValue) edge = true;
        }

        // various checks for whether to keep the next point
        if (edge) return;
        if (!minVal || minVal[2] > centerValue) return;
        if (minVal[0] < 0 || minVal[0] >= width || minVal[1] < 0 || minVal[1] >= height) {
            return;
        }

        // if all is good, store the next lowest point
        var next = [minVal[0], minVal[1]];

        data[n] = { v: centerValue, next: next };
    }

    function createPath(startCoords) {
        var keepGoing = true;
        var path = { count: 0, currentIndex: 0, coords: [startCoords] };
        var current;
        var recent = [startCoords];
        var x;
        var y;
        while (keepGoing) {
            // current point
            current = path.coords[path.coords.length - 1];
            var x = current[0];
            var y = current[1];
            var i = getIndexForCoordinates(width, x, y);

            // if there is no data (i.e., elevation and 'next') at this point, calculate it
            if (!data[i]) getDataAtPoint(i, x, y);
            // if there's still no data after that, things will fail below and the path will end

            if (!demData[i] || elev(i, demData) <= 0 || !data[i]) { // check to make sure data exists here; honestly not sure what this is catching anymore
                keepGoing = false;
            } else {
                // next point, according to data at this location
                var newX = data[i].next[0];
                var newY = data[i].next[1];

                // this bit checks if the path hasn't gotten very far after several steps
                // sometimes paths are super short or somehow get stuck at the end bouncing back and forth in a small space
                if (recent.length == 5) recent.shift();
                recent.push([newX, newY]);
                var dx = recent.length < 5 ? 999 : Math.abs(recent[2][0] - newX)
                var dy = recent.length < 5 ? 999 : Math.abs(recent[2][1] - newY)

                var i2 = getIndexForCoordinates(width, newX, newY);

                if (!demData[i2] || elev(i2, demData) > elev(i, demData) || elev(i2, demData) <= 0 || (dx < 3 && dy < 3)) {
                    // if no data at next point, or next point is higher than current point, or path is too short, we're at the end
                    // probably some old redundancy left over in some of those conditions, but you never know
                    keepGoing = false;
                } else {
                    // otherwise, add the new point
                    path.coords[path.coords.length] = [newX, newY];
                }
            }
        }
        if (path.coords.length > 2) return path;  // discard path if too short
        return null;
    }

    // convert mapzen tile color to elevation value
    function elev(index, demData) {
        if (index < 0 || demData[index] === undefined) return undefined;
        return (demData[index] * 256 + demData[index + 1] + demData[index + 2] / 256) - 32768;
    }

    // helper to get imageData index for a given x/y
    function getIndexForCoordinates(width, x, y) {
        return width * y * 4 + 4 * x;
    }

    function drawFlows() {
        document.getElementById('drawing').style.display = 'none';
        clearInterval(flowInterval);


        var next = true;

        var drawCount = 0;

        flowInterval = setInterval(function () {
            // fade out the existing canvas a little bit. this is what creates the trail effect
            flowContext.save();
            flowContext.globalCompositeOperation = 'destination-out';
            flowContext.globalAlpha = 0.1;
            flowContext.fillRect(0, 0, width, height);
            flowContext.restore();

            // now go through all paths and draw each to its next coordinate
            for (var c in paths) {
                // if next will be past the end...
                if (paths[c].currentIndex + 1 >= paths[c].coords.length) {
                    if (paths[c].count > 50) {
                        // only start over if this has run 50 frames. prevents short paths from looping annoyingly quickly
                        paths[c].currentIndex = 0;
                        paths[c].count = 0;
                        paths[c].idle = false;
                    } else {
                        // if we're not there yet, wait
                        paths[c].idle = true;
                        paths[c].count++;
                        continue;
                    }
                }
                // draw from current point to next point
                var x = paths[c].coords[paths[c].currentIndex][0];
                var y = paths[c].coords[paths[c].currentIndex][1];
                paths[c].currentIndex++;
                var newX = paths[c].coords[paths[c].currentIndex][0];
                var newY = paths[c].coords[paths[c].currentIndex][1];
                flowContext.beginPath();
                flowContext.moveTo(x, y);
                flowContext.lineTo(newX, newY);
                paths[c].count++;
                flowContext.stroke();
            }
        }, 50);
    }
});