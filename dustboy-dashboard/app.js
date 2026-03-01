import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- CONFIGURATION ---
const TARGET_API = 'https://open-api.cmuccdc.org/aqic/dustboy';
const CORS_PROXIES = [
    'https://api.allorigins.win/raw?url=',
    'https://cors-anywhere.herokuapp.com/',
    'https://corsproxy.io/?'
];
const MQTT_BROKER = 'wss://dustboy-wss-bridge.laris.workers.dev/mqtt';
const MQTT_TOPIC = 'DUSTBOY/+/+/+/status';

const MAP_SCALE_Y = 15; // Vertical stretching of coordinates
const MAP_SCALE_X = 15;

// Thai Geographical Bounds (Approx)
const THAI_BOUNDS = {
    minLat: 5.61, maxLat: 20.46,
    minLon: 97.34, maxLon: 105.63
};

// Data Store
const sensors = new Map(); // ID -> Mesh
let maxPM25Value = 0;

// --- UTILS ---
function normalize(val, min, max) {
    return (val - min) / (max - min) - 0.5;
}

function getAQIColor(pm25) {
    if (pm25 <= 15) return 0x00ff80; // Green
    if (pm25 <= 25) return 0xffcc00; // Yellow
    if (pm25 <= 37) return 0xff6b00; // Orange
    if (pm25 <= 50) return 0xff003c; // Red
    return 0x9f1239; // Deep Red
}

function latLonToVector3(lat, lon) {
    const nx = normalize(lon, THAI_BOUNDS.minLon, THAI_BOUNDS.maxLon) * MAP_SCALE_X;
    const nz = normalize(lat, THAI_BOUNDS.minLat, THAI_BOUNDS.maxLat) * -MAP_SCALE_Y; // Flip Z for correct north/south
    return new THREE.Vector3(nx, 0, nz);
}

// --- THREE.JS SCENE SETUP ---
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050510, 0.04);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 10, 15);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ReinhardToneMapping;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // Don't go below ground

// --- LIGHTING ---
scene.add(new THREE.AmbientLight(0x0a1929, 2));

const dirLight = new THREE.DirectionalLight(0x00ffff, 1);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

// --- CYBERPUNK GRID FLOOR ---
const gridHelper = new THREE.GridHelper(50, 100, 0x00ffff, 0x0f2942);
gridHelper.position.y = -0.1;
scene.add(gridHelper);

const planeGeo = new THREE.PlaneGeometry(50, 50);
const planeMat = new THREE.MeshBasicMaterial({ color: 0x050510, side: THREE.DoubleSide });
const plane = new THREE.Mesh(planeGeo, planeMat);
plane.rotation.x = Math.PI / 2;
plane.position.y = -0.15;
scene.add(plane);

// --- PILLAR GENERATION ---
const pillarGroup = new THREE.Group();
scene.add(pillarGroup);

// Geometries & Base Materials (Instancing could be used, but individual meshes allow simpler GSAP animation)
const boxGeo = new THREE.BoxGeometry(0.12, 1, 0.12);
// Move pivot to bottom
boxGeo.translate(0, 0.5, 0);

function createPillar(id, lat, lon, pm25, name) {
    const color = getAQIColor(pm25);
    const mat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: color,
        emissiveIntensity: 0.6,
        roughness: 0.2,
        metalness: 0.8
    });

    const mesh = new THREE.Mesh(boxGeo, mat);
    const pos = latLonToVector3(lat, lon);

    mesh.position.copy(pos);

    // Scale height based on PM2.5 (min height 0.1)
    const targetHeight = Math.max(0.1, pm25 * 0.05);
    mesh.scale.y = 0; // Start at 0 for spawn animation

    // Attach userData for Raycasting
    mesh.userData = { id, name, pm25, pm10: '--', temp: '--', humid: '--', color };

    pillarGroup.add(mesh);
    sensors.set(id, mesh);

    // Initial Spawn Animation
    gsap.to(mesh.scale, {
        y: targetHeight,
        duration: 2 + Math.random() * 2,
        ease: "elastic.out(1, 0.5)"
    });

    updateGlobalStats(pm25);
}

function updatePillar(id, data) {
    const mesh = sensors.get(id);
    if (!mesh) return;

    if (data.pm2_5 !== undefined) {
        mesh.userData.pm25 = data.pm2_5;
        const newColor = getAQIColor(data.pm2_5);
        const targetHeight = Math.max(0.1, data.pm2_5 * 0.05);

        // Ensure color is a THREE.Color instance
        const colorObj = new THREE.Color(newColor);

        // Animate color and height
        gsap.to(mesh.scale, { y: targetHeight, duration: 1, ease: "power2.out" });
        gsap.to(mesh.material.color, { r: colorObj.r, g: colorObj.g, b: colorObj.b, duration: 1 });
        gsap.to(mesh.material.emissive, { r: colorObj.r, g: colorObj.g, b: colorObj.b, duration: 1 });

        mesh.userData.color = newColor;
        updateGlobalStats(data.pm2_5);
    }

    if (data.pm10 !== undefined) mesh.userData.pm10 = data.pm10;
    if (data.temperature_c !== undefined) mesh.userData.temp = data.temperature_c;
    if (data.humidity_rh !== undefined) mesh.userData.humid = data.humidity_rh;

    // Refresh tooltip if this is the selected sensor
    if (selectedSensor === mesh) {
        updateTooltipContent(mesh);
    }
}

function updateGlobalStats(newPm25) {
    maxPM25Value = Math.max(maxPM25Value, newPm25);
    document.getElementById('stat-sensors').innerText = sensors.size.toLocaleString();
    if (newPm25 >= maxPM25Value) {
        document.getElementById('stat-max').innerText = maxPM25Value;
    }
}

// --- INTERACTION (RAYCASTER) ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let selectedSensor = null;

const tooltip = document.getElementById('sensor-tooltip');
const tipName = document.getElementById('tip-name');
const tipId = document.getElementById('tip-id');
const tipPm25 = document.getElementById('tip-pm25');
const tipPm10 = document.getElementById('tip-pm10');
const tipEnviron = document.getElementById('tip-environ');

window.addEventListener('click', onMouseClick);
window.addEventListener('mousemove', onMouseMove);

function onMouseMove(event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
}

function onMouseClick() {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(pillarGroup.children);

    if (intersects.length > 0) {
        const object = intersects[0].object;
        selectedSensor = object;

        // Visual feedback (pulse emissive)
        gsap.killTweensOf(object.material);
        object.material.emissiveIntensity = 2;
        gsap.to(object.material, { emissiveIntensity: 0.6, duration: 1 });

        updateTooltipContent(object);
        tooltip.classList.add('visible');
    } else {
        selectedSensor = null;
        tooltip.classList.remove('visible');
    }
}

function updateTooltipContent(mesh) {
    const data = mesh.userData;
    tipName.innerText = data.name || 'Unknown Location';
    tipId.innerText = data.id;
    tipPm25.innerHTML = `${data.pm25}<span> µg/m³</span>`;
    tipPm25.style.color = '#' + new THREE.Color(data.color).getHexString();
    tipPm10.innerHTML = `${data.pm10}<span> µg/m³</span>`;
    tipEnviron.innerText = `${data.temp}°C / ${data.humid}%`;
}


// --- DATA FETCHING (REST API First) ---
async function fetchInitialData() {
    let json = null;
    let success = false;

    // Try each proxy until one works
    for (const proxy of CORS_PROXIES) {
        try {
            console.log(`Attempting to fetch data via proxy: ${proxy}`);
            const response = await fetch(`${proxy}${encodeURIComponent(TARGET_API)}`);

            // allorigins specifically returns { contents: "..." }
            if (proxy.includes('allorigins')) {
                const data = await response.json();
                json = JSON.parse(data.contents);
            } else {
                json = await response.json();
            }

            if (json && json.length > 0) {
                success = true;
                console.log('Successfully fetched Data!');
                break; // Stop trying other proxies
            }
        } catch (err) {
            console.warn(`Failed with proxy ${proxy}`);
        }
    }

    if (success && json) {
        json.forEach(station => {
            const lat = parseFloat(station.dustboy_lat);
            const lon = parseFloat(station.dustboy_lon);
            const pm25 = parseFloat(station.pm25) || 0;

            if (!isNaN(lat) && !isNaN(lon)) {
                createPillar(station.dustboy_id, lat, lon, pm25, station.dustboy_name_en || station.dustboy_name);
            }
        });

        // Hide Loader
        document.getElementById('loader').style.opacity = '0';
        setTimeout(() => document.getElementById('loader').style.display = 'none', 500);

        // Auto-center camera around data center (approx Thailand center)
        gsap.to(controls.target, { x: 0, y: 0, z: 0, duration: 3, ease: 'power2.inOut' });
    } else {
        console.error("All CORS proxies failed to fetch API data");
        document.getElementById('loader-msg').innerText = "REST API ERROR (All Proxies Failed)";
        document.getElementById('loader-msg').style.color = '#ef4444';

        // Even if REST fails, allow MQTT to connect
        document.getElementById('loader').style.opacity = '0';
        setTimeout(() => document.getElementById('loader').style.display = 'none', 500);
    }
}

// --- MQTT LIVE UPDATES ---
function connectMQTT() {
    const statusBadge = document.getElementById('mqtt-status');
    const client = mqtt.connect(MQTT_BROKER);

    client.on('connect', () => {
        console.log('MQTT Connected');
        statusBadge.innerText = '● LIVE FEED';
        statusBadge.classList.remove('connecting');
        client.subscribe(MQTT_TOPIC, (err) => {
            if (err) console.error('Subscription error', err);
        });
    });

    client.on('message', (topic, message) => {
        try {
            const payload = JSON.parse(message.toString());
            const data = payload.d;
            if (data && data.myName) {
                // Determine ID (Sometimes myName, sometimes from MAC)
                const id = data.myName;

                if (sensors.has(id)) {
                    updatePillar(id, data);
                } else if (payload.ip && data.pm2_5 !== undefined) {
                    // We don't have lat/lon from MQTT alone, so we can't spawn new pillars 
                    // without coordinates. We only update existing ones from the REST API.
                    // If we had coordinates in the MQTT payload, we could call createPillar here.
                    console.log(`Received data for unknown sensor: ${id}`);
                }
            }
        } catch (e) {
            console.error('JSON Parse error', e);
        }
    });

    client.on('error', (err) => {
        console.error('MQTT Error', err);
        statusBadge.innerText = 'CONNECTION ERROR';
        statusBadge.style.color = '#ef4444';
        statusBadge.style.borderColor = '#ef4444';
    });
}

// --- RENDER LOOP ---
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

// --- INITIALIZATION ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

fetchInitialData().then(() => {
    connectMQTT();
});

animate();
