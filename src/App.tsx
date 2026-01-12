import { useEffect } from 'react';
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

// --- TYPES ---
interface PlayerState {
    x: number;
    z: number;
    y: number; // Vertical position
    vy: number; // Vertical velocity
    dir: number;
    pitch: number;
    speed: number;
    radius: number;
}

interface InputState {
    fwd: number;
    side: number;
    rotX: number;
    rotY: number;
}

interface Wall {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

// --- CONSTANTS FOR STYLES ---
const SCANLINE_STYLE: React.CSSProperties = {
    background: 'linear-gradient(rgba(18, 16, 0, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06))',
    backgroundSize: '100% 2px, 3px 100%',
};

export default function App() {
    const [gameState, setGameState] = useState<'MENU' | 'PLAYING' | 'WON' | 'LOST'>('MENU');
    const [level, setLevel] = useState<number>(0); // 0 = Lobby (Yellow), 1 = Concrete (Dark)
    const [flashlightOn, setFlashlightOn] = useState<boolean>(true);
    
    // Refs for game state to avoid re-renders during loop
    const mountRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const frameIdRef = useRef<number>(0);
    const timerRef = useRef<HTMLDivElement>(null);
    const startTimeRef = useRef<number>(0);
    const isGameEndedRef = useRef<boolean>(false);
    
    // Game Logic Refs
    const playerRef = useRef<PlayerState>({
        x: 0, z: 0,
        y: 0, vy: 0,
        dir: 0,
        pitch: 0,
        speed: 0.12,
        radius: 0.4
    });
    
    // Flashlight & Sanity Refs
    const isFlashlightOnRef = useRef<boolean>(true); // To access inside animation loop without re-render
    const flashlightTimerRef = useRef<number>(0); // Seconds flashlight is on
    const sanityAudioGainRef = useRef<GainNode | null>(null);
    const ambienceFilterRef = useRef<BiquadFilterNode | null>(null);
    
    const inputRef = useRef<InputState>({ fwd: 0, side: 0, rotX: 0, rotY: 0 });
    const wallsRef = useRef<Wall[]>([]);
    
    // Audio Context
    const audioCtxRef = useRef<AudioContext | null>(null);

    // Touch Handling Refs
    const touchIdLeft = useRef<number | null>(null);
    const touchIdRight = useRef<number | null>(null);
    const startX = useRef<number>(0);
    const startY = useRef<number>(0);
    const lastLookX = useRef<number>(0);
    const lastLookY = useRef<number>(0);
    
    // Joystick UI Refs
    const joyBaseRef = useRef<HTMLDivElement>(null);
    const joyStickRef = useRef<HTMLDivElement>(null);

    // --- TEXTURE GENERATION ---
    const createTexture = (color: string, noiseAmount: number, type: 'smooth' | 'rough' = 'smooth') => {
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return new THREE.Texture();
        
        // Cor base
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, size, size);
        
        // Ruído
        const iterations = type === 'rough' ? 120000 : 80000;
        for(let i=0; i<iterations; i++) {
            ctx.fillStyle = Math.random() > 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
            const s = type === 'rough' ? Math.random() * 3 : 2;
            ctx.fillRect(Math.random()*size, Math.random()*size, s, s);
        }
        
        // Sujeira (Manchas grandes)
        for(let i=0; i<10; i++) {
            const x = Math.random()*size; 
            const y = Math.random()*size;
            const r = Math.random()*100 + 50;
            const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
            grd.addColorStop(0, "rgba(0,0,0,0.1)");
            grd.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = grd;
            ctx.beginPath(); ctx.arc(x,y,r,0,2*Math.PI); ctx.fill();
        }

        // Se for concreto (rough), adiciona umas rachaduras simples
        if (type === 'rough') {
            ctx.strokeStyle = 'rgba(0,0,0,0.2)';
            ctx.lineWidth = 1;
            for(let i=0; i<5; i++) {
                ctx.beginPath();
                ctx.moveTo(Math.random()*size, Math.random()*size);
                ctx.lineTo(Math.random()*size, Math.random()*size);
                ctx.stroke();
            }
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        return tex;
    };

    // --- AUDIO INIT ---
    const initAudio = () => {
        if (audioCtxRef.current) return;
        
        const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
        const audioCtx = new AudioContext();
        audioCtxRef.current = audioCtx;

        // 1. Ambience (Brown Noise)
        const bufferSize = audioCtx.sampleRate * 2;
        const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        let lastOut = 0;
        for (let i = 0; i < bufferSize; i++) {
            const white = Math.random() * 2 - 1;
            data[i] = (lastOut + (0.02 * white)) / 1.02;
            lastOut = data[i];
            data[i] *= 3.5; 
        }
        
        const noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        noise.loop = true;
        
        // Ambience Filter (Changed by Level)
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 150; 
        ambienceFilterRef.current = filter;

        // 2. Hum (60Hz)
        const osc = audioCtx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 55;
        const oscGain = audioCtx.createGain();
        oscGain.gain.value = 0.05;

        // 3. Voices / Sanity Sounds (Synthesized)
        // Three oscillators detuned to create dissonance
        const sanityGain = audioCtx.createGain();
        sanityGain.gain.value = 0; // Start silent
        sanityAudioGainRef.current = sanityGain;

        const vOsc1 = audioCtx.createOscillator(); vOsc1.frequency.value = 200; vOsc1.type = 'triangle';
        const vOsc2 = audioCtx.createOscillator(); vOsc2.frequency.value = 233; vOsc2.type = 'sine'; // Dissonant interval
        const vOsc3 = audioCtx.createOscillator(); vOsc3.frequency.value = 180; vOsc3.type = 'sawtooth';

        // LFO for Tremolo on voices
        const lfo = audioCtx.createOscillator();
        lfo.frequency.value = 2; // 2Hz wobble
        const lfoGain = audioCtx.createGain();
        lfoGain.gain.value = 50;
        
        lfo.connect(lfoGain);
        lfoGain.connect(vOsc1.detune);
        lfoGain.connect(vOsc2.detune);

        vOsc1.connect(sanityGain);
        vOsc2.connect(sanityGain);
        vOsc3.connect(sanityGain);

        // Connections
        noise.connect(filter);
        filter.connect(audioCtx.destination);
        
        osc.connect(oscGain);
        oscGain.connect(audioCtx.destination);

        sanityGain.connect(audioCtx.destination);

        noise.start();
        osc.start();
        vOsc1.start();
        vOsc2.start();
        vOsc3.start();
        lfo.start();
    };

    // --- GAME ACTIONS ---
    
    // Sync ref when state changes
    useEffect(() => {
        isFlashlightOnRef.current = flashlightOn;
    }, [flashlightOn]);

    const toggleFlashlight = () => {
        setFlashlightOn(prev => !prev);
    };

    const jump = () => {
        if (playerRef.current.y <= 0.01) {
            playerRef.current.vy = 0.15; // Jump force
        }
    };

    // --- 3D INIT & LOOP ---
    useEffect(() => {
        if (gameState !== 'PLAYING' || !mountRef.current) return;

        isGameEndedRef.current = false;
        
        // Update Audio for Level
        if (ambienceFilterRef.current && audioCtxRef.current) {
            const time = audioCtxRef.current.currentTime;
            if (level === 0) {
                // Muffled, heavy atmosphere
                ambienceFilterRef.current.frequency.setValueAtTime(150, time);
                ambienceFilterRef.current.Q.value = 1;
            } else {
                // More open, windy, industrial
                ambienceFilterRef.current.frequency.setValueAtTime(600, time);
                ambienceFilterRef.current.Q.value = 5;
            }
        }

        // Setup Scene
        const scene = new THREE.Scene();
        
        // -- VISUALS BASED ON LEVEL --
        let wallColor, floorColor, fogColor, fogDensity;
        
        if (level === 0) {
            // LEVEL 0: The Mono-Yellow
            wallColor = '#cfc68a';
            floorColor = '#9c9472';
            fogColor = 0xd4cd96;
            fogDensity = 0.15;
            scene.background = new THREE.Color(fogColor);
        } else {
            // LEVEL 1: The Concrete / Dark Industrial
            wallColor = '#5a5a5a'; // Cinza escuro
            floorColor = '#333333'; // Quase preto
            fogColor = 0x111111; // Escuridão total
            fogDensity = 0.20; // Mais denso
            scene.background = new THREE.Color(fogColor);
        }

        scene.fog = new THREE.FogExp2(fogColor, fogDensity);
        sceneRef.current = scene;

        // Setup Camera
        const camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.1, 50);
        camera.rotation.order = "YXZ";
        cameraRef.current = camera;

        // Setup Renderer
        const renderer = new THREE.WebGLRenderer({ antialias: false });
        renderer.setSize(window.innerWidth, window.innerHeight);
        mountRef.current.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        // Lighting
        const ambient = new THREE.AmbientLight(0xffffff, level === 0 ? 0.4 : 0.1); 
        scene.add(ambient);
        
        // Lanterna do jogador
        const pLight = new THREE.PointLight(level === 0 ? 0xffaa00 : 0xffffff, 0.8, 20);
        camera.add(pLight);
        scene.add(camera);

        // --- MAP GENERATION ---
        const textureType = level === 0 ? 'smooth' : 'rough';
        const texWall = createTexture(wallColor, 0.1, textureType);
        const texFloor = createTexture(floorColor, 0.2, textureType);
        const texCeil = createTexture(level === 0 ? '#e0e0e0' : '#222222', 0.05, 'smooth');

        texFloor.repeat.set(20,20);
        texCeil.repeat.set(10,10);

        const matWall = new THREE.MeshLambertMaterial({ map: texWall });
        const matFloor = new THREE.MeshLambertMaterial({ map: texFloor });
        const matCeil = new THREE.MeshBasicMaterial({ map: texCeil });

        // Floor & Ceiling
        const planeGeo = new THREE.PlaneGeometry(100, 100);
        const floorMesh = new THREE.Mesh(planeGeo, matFloor);
        floorMesh.rotation.x = -Math.PI/2;
        scene.add(floorMesh);

        const ceilMesh = new THREE.Mesh(planeGeo, matCeil);
        ceilMesh.rotation.x = Math.PI/2;
        ceilMesh.position.y = 3.5;
        scene.add(ceilMesh);

        // Walls
        const newWalls: Wall[] = [];
        const addWall = (x: number, z: number, w: number, d: number) => {
            const h = 3.5;
            const geo = new THREE.BoxGeometry(w, h, d);
            const mesh = new THREE.Mesh(geo, matWall);
            mesh.position.set(x, h/2, z);
            scene.add(mesh);

            newWalls.push({
                minX: x - w/2, maxX: x + w/2,
                minZ: z - d/2, maxZ: z + d/2
            });
        };

        // Outer Walls (Boundaries)
        addWall(0, -25, 51, 1);
        addWall(0, 25, 51, 1);
        addWall(-25, 0, 1, 51);
        addWall(25, 0, 1, 51);

        // --- RANDOM DOOR GENERATION ---
        const doorAngle = Math.random() * Math.PI * 2;
        const doorDist = 15 + Math.random() * 7;
        const doorX = Math.sin(doorAngle) * doorDist;
        const doorZ = Math.cos(doorAngle) * doorDist;

        // Procedural Inner Walls
        const wallCount = level === 0 ? 25 : 35;
        
        for(let i=0; i<wallCount; i++) {
            let rx = (Math.random()*40) - 20;
            let rz = (Math.random()*40) - 20;
            let rw = Math.random() > 0.5 ? 4 : 1;
            let rd = rw === 1 ? 4 : 1;
            
            if(Math.abs(rx) < 4 && Math.abs(rz) < 4) continue;
            if(Math.abs(rx - doorX) < 4 && Math.abs(rz - doorZ) < 4) continue;

            addWall(rx, rz, rw, rd);
        }
        wallsRef.current = newWalls;

        // --- THE DOOR (EXIT) ---
        const doorGeo = new THREE.BoxGeometry(2, 3.5, 0.5);
        const doorColor = level === 0 ? 0x000000 : 0xffffff;
        const doorMat = new THREE.MeshBasicMaterial({ color: doorColor });
        if (level === 1) doorMat.emissive = new THREE.Color(0xffffff);
        
        const doorMesh = new THREE.Mesh(doorGeo, doorMat);
        doorMesh.position.set(doorX, 1.75, doorZ);
        doorMesh.lookAt(0, 1.75, 0); 
        scene.add(doorMesh);

        if (level === 1) {
            const exitLight = new THREE.PointLight(0xffffff, 1, 10);
            exitLight.position.set(doorX, 2, doorZ);
            scene.add(exitLight);
        }

        // --- ANIMATION LOOP ---
        const clock = new THREE.Clock();

        const checkCollision = (x: number, z: number) => {
            const player = playerRef.current;
            for(const w of wallsRef.current) {
                if (x + player.radius > w.minX && x - player.radius < w.maxX &&
                    z + player.radius > w.minZ && z - player.radius < w.maxZ) {
                    return true;
                }
            }
            return false;
        };

        const animate = () => {
            frameIdRef.current = requestAnimationFrame(animate);
            if (isGameEndedRef.current) return;
            
            const dt = clock.getDelta();
            const player = playerRef.current;
            const input = inputRef.current;

            // --- FLASHLIGHT SANITY LOGIC ---
            if (isFlashlightOnRef.current) { // Check Ref instead of State
                pLight.intensity = level === 0 ? 0.8 : 1.0;
                flashlightTimerRef.current += dt;
                
                // If flashlight is on for > 15s, voices start
                if (flashlightTimerRef.current > 15) {
                    // Ramp up volume
                    if (sanityAudioGainRef.current) {
                        const currentVol = sanityAudioGainRef.current.gain.value;
                        sanityAudioGainRef.current.gain.value = Math.min(0.2, currentVol + 0.001);
                    }
                    // Flicker light
                    if (Math.random() > 0.8) pLight.intensity *= 0.5;
                } else {
                    // Fade out volume if < 15s (shouldn't happen if logic is tight but for safety)
                    if (sanityAudioGainRef.current) sanityAudioGainRef.current.gain.value = 0;
                }
            } else {
                pLight.intensity = 0;
                // Cooldown sanity
                flashlightTimerRef.current = Math.max(0, flashlightTimerRef.current - (dt * 2));
                // Fade out voices
                if (sanityAudioGainRef.current) {
                     const currentVol = sanityAudioGainRef.current.gain.value;
                     sanityAudioGainRef.current.gain.value = Math.max(0, currentVol - 0.01);
                }
            }

            // --- TIMER LOGIC ---
            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            const remaining = Math.max(0, 300 - elapsed);
            
            if (timerRef.current) {
                const m = Math.floor(remaining / 60).toString().padStart(2, '0');
                const s = Math.floor(remaining % 60).toString().padStart(2, '0');
                timerRef.current.innerText = `${m}:${s}`;
                // Red text if time low or sanity bad
                if (remaining < 30 || flashlightTimerRef.current > 15) {
                    timerRef.current.style.color = '#ff0000';
                } else {
                    timerRef.current.style.color = '#d4cd96';
                }
            }

            if (remaining <= 0) {
                isGameEndedRef.current = true;
                setGameState('LOST');
                return;
            }

            // --- DOOR LOGIC ---
            const distToDoor = Math.hypot(player.x - doorX, player.z - doorZ);
            if (distToDoor < 1.5) {
                if (level === 0) {
                    setLevel(1);
                    playerRef.current.x = 0;
                    playerRef.current.z = 0;
                    // Reset Timer & Sanity
                    startTimeRef.current = Date.now();
                    flashlightTimerRef.current = 0;
                } else {
                    isGameEndedRef.current = true;
                    setGameState('WON');
                }
                return;
            }

            // --- PHYSICS (GRAVITY & JUMP) ---
            player.vy -= 0.015; // Gravity
            player.y += player.vy;

            // Floor collision
            if (player.y < 0) {
                player.y = 0;
                player.vy = 0;
            }

            // --- MOVEMENT ---
            const speed = player.speed;
            const cos = Math.cos(input.rotY);
            const sin = Math.sin(input.rotY);

            let dz = (input.fwd * cos) - (input.side * sin);
            let dx = (input.fwd * sin) + (input.side * cos);

            dx *= speed;
            dz *= speed;

            // Collision with Walls
            if(!checkCollision(player.x - dx, player.z)) {
                player.x -= dx;
            }
            if(!checkCollision(player.x, player.z - dz)) {
                player.z -= dz;
            }

            // Head Bob (Only if on ground)
            let bobY = 0;
            if (player.y === 0 && (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01)) {
                bobY = Math.sin(Date.now() * 0.015) * 0.05;
            }

            // Update Camera
            const baseHeight = 1.6;
            camera.position.x = player.x;
            camera.position.z = player.z;
            camera.position.y = baseHeight + player.y + bobY;
            camera.rotation.y = input.rotY;
            camera.rotation.x = input.rotX;

            renderer.render(scene, camera);
        };
        
        animate();

        return () => {
            cancelAnimationFrame(frameIdRef.current);
            if (rendererRef.current && mountRef.current) {
                mountRef.current.removeChild(rendererRef.current.domElement);
                rendererRef.current.dispose();
            }
        };
    }, [gameState, level]); // REMOVED flashlightOn from dependencies

    // Resize Handler
    useEffect(() => {
        const handleResize = () => {
            if (cameraRef.current && rendererRef.current) {
                cameraRef.current.aspect = window.innerWidth / window.innerHeight;
                cameraRef.current.updateProjectionMatrix();
                rendererRef.current.setSize(window.innerWidth, window.innerHeight);
            }
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // --- INPUT HANDLERS ---
    useEffect(() => {
        if (gameState !== 'PLAYING') return;

        const handleTouchStart = (e: TouchEvent) => {
            // Prevent default only if touching joystick area or buttons to avoid blocking UI interaction if needed
            // But for this game, we largely want to prevent scrolling
            // e.preventDefault(); 
            
            for(let i=0; i<e.changedTouches.length; i++) {
                const t = e.changedTouches[i];
                const halfScreen = window.innerWidth / 2;
                const bottomArea = window.innerHeight - 150; // Reserve bottom area for buttons

                // Check if touching Buttons (Simple zone check)
                const target = t.target as HTMLElement;
                if(target.id === 'btn-jump' || target.id === 'btn-light') continue;

                // LEFT (Joystick) - Only if not in button area roughly
                if(t.clientX < halfScreen && t.clientY < bottomArea && touchIdLeft.current === null) {
                    touchIdLeft.current = t.identifier;
                    startX.current = t.clientX;
                    startY.current = t.clientY;
                    
                    if (joyBaseRef.current && joyStickRef.current) {
                        joyBaseRef.current.style.display = 'block';
                        joyBaseRef.current.style.left = (t.clientX - 60) + 'px';
                        joyBaseRef.current.style.top = (t.clientY - 60) + 'px';
                        joyStickRef.current.style.transform = `translate(-50%, -50%)`;
                    }
                }
                
                // RIGHT (Look) - Only if not in button area
                if(t.clientX > halfScreen && t.clientY < bottomArea && touchIdRight.current === null) {
                    touchIdRight.current = t.identifier;
                    lastLookX.current = t.clientX;
                    lastLookY.current = t.clientY;
                }
            }
        };

        const handleTouchMove = (e: TouchEvent) => {
            e.preventDefault();
            for(let i=0; i<e.changedTouches.length; i++) {
                const t = e.changedTouches[i];

                if(t.identifier === touchIdLeft.current) {
                    let dx = t.clientX - startX.current;
                    let dy = t.clientY - startY.current;
                    const dist = Math.min(Math.sqrt(dx*dx+dy*dy), 60);
                    const angle = Math.atan2(dy, dx);
                    const visualX = Math.cos(angle) * dist;
                    const visualY = Math.sin(angle) * dist;
                    
                    if (joyStickRef.current) {
                        joyStickRef.current.style.transform = `translate(calc(-50% + ${visualX}px), calc(-50% + ${visualY}px))`;
                    }
                    inputRef.current.side = -(visualX / 60);
                    inputRef.current.fwd = -(visualY / 60);
                }

                if(t.identifier === touchIdRight.current) {
                    const dx = t.clientX - lastLookX.current;
                    const dy = t.clientY - lastLookY.current;
                    inputRef.current.rotY -= dx * 0.005;
                    inputRef.current.rotX -= dy * 0.005;
                    inputRef.current.rotX = Math.max(-1.5, Math.min(1.5, inputRef.current.rotX));
                    lastLookX.current = t.clientX;
                    lastLookY.current = t.clientY;
                }
            }
        };

        const handleTouchEnd = (e: TouchEvent) => {
            for(let i=0; i<e.changedTouches.length; i++) {
                if(e.changedTouches[i].identifier === touchIdLeft.current) {
                    touchIdLeft.current = null;
                    inputRef.current.fwd = 0;
                    inputRef.current.side = 0;
                    if (joyBaseRef.current) joyBaseRef.current.style.display = 'none';
                }
                if(e.changedTouches[i].identifier === touchIdRight.current) {
                    touchIdRight.current = null;
                }
            }
        };

        // Key listeners
        const handleKeyDown = (e: KeyboardEvent) => {
            if(e.key === 'w') inputRef.current.fwd = 1;
            if(e.key === 's') inputRef.current.fwd = -1;
            if(e.key === 'a') inputRef.current.side = 1;
            if(e.key === 'd') inputRef.current.side = -1;
            if(e.code === 'Space') jump();
            if(e.key.toLowerCase() === 'e') toggleFlashlight();
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            if(['w','s'].includes(e.key)) inputRef.current.fwd = 0;
            if(['a','d'].includes(e.key)) inputRef.current.side = 0;
        };
        
        const handleMouseMove = (e: MouseEvent) => {
            if(gameState === 'PLAYING' && !touchIdRight.current) {
                inputRef.current.rotY -= e.movementX * 0.002;
                inputRef.current.rotX -= e.movementY * 0.002;
                inputRef.current.rotX = Math.max(-1.5, Math.min(1.5, inputRef.current.rotX));
            }
        };

        // Attach listeners
        document.addEventListener('touchstart', handleTouchStart, {passive: false});
        document.addEventListener('touchmove', handleTouchMove, {passive: false});
        document.addEventListener('touchend', handleTouchEnd);
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        document.addEventListener('mousemove', handleMouseMove);

        return () => {
            document.removeEventListener('touchstart', handleTouchStart);
            document.removeEventListener('touchmove', handleTouchMove);
            document.removeEventListener('touchend', handleTouchEnd);
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            document.removeEventListener('mousemove', handleMouseMove);
        };
    }, [gameState]); // Removed dependencies to avoid stale closures, using refs for mutable state

    const handleStart = () => {
        setGameState('PLAYING');
        setLevel(0);
        startTimeRef.current = Date.now();
        flashlightTimerRef.current = 0;
        setFlashlightOn(true);
        // Reset Player Position
        playerRef.current = {
            x: 0, z: 0,
            y: 0, vy: 0,
            dir: 0, pitch: 0,
            speed: 0.12, radius: 0.4
        };
        inputRef.current = { fwd: 0, side: 0, rotX: 0, rotY: 0 };
        
        initAudio();
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {});
        }
    };

    return (
        <div className="relative w-full h-full bg-black overflow-hidden select-none touch-none">
            {/* MENU SCREEN */}
            {gameState === 'MENU' && (
                <div className="absolute top-0 left-0 w-full h-full bg-[#111] z-50 flex flex-col items-center justify-center text-[#d4cd96] text-center">
                    <h1 className="text-5xl font-bold mb-3 drop-shadow-[0_0_10px_#d4cd96]" style={{fontFamily: "'Courier New', Courier, monospace"}}>THE BACKROOMS</h1>
                    <p className="font-mono">Use fones de ouvido.</p>
                    <p className="font-mono mt-2 text-sm md:text-base">WASD / Joystick: ANDAR | Mouse / Toque: OLHAR</p>
                    <p className="font-mono mt-1 text-sm md:text-base">ESPAÇO: Pular | E: Lanterna</p>
                    <p className="font-mono mt-4 text-red-500 font-bold">TEMPO LIMITE: 5 MINUTOS</p>
                    <p className="font-mono text-xs text-gray-500">Cuidado com a sanidade.</p>
                    <button 
                        onClick={handleStart}
                        className="mt-6 px-10 py-5 text-2xl font-bold bg-[#8f8856] border-2 border-[#d4cd96] text-[#111] uppercase cursor-pointer hover:bg-[#a39b62] active:bg-[#d4cd96]"
                        style={{fontFamily: "'Courier New', Courier, monospace"}}
                    >
                        ACORDAR
                    </button>
                </div>
            )}

            {/* WON SCREEN */}
            {gameState === 'WON' && (
                <div className="absolute top-0 left-0 w-full h-full bg-white z-50 flex flex-col items-center justify-center text-black text-center animate-pulse">
                    <h1 className="text-6xl font-bold mb-4">VOCÊ ESCAPOU</h1>
                    <p className="text-2xl">A realidade voltou ao normal.</p>
                    <button 
                        onClick={() => setGameState('MENU')}
                        className="mt-8 px-6 py-3 border-2 border-black hover:bg-black hover:text-white transition-colors"
                    >
                        JOGAR NOVAMENTE
                    </button>
                </div>
            )}

            {/* LOST SCREEN */}
            {gameState === 'LOST' && (
                <div className="absolute top-0 left-0 w-full h-full bg-black z-50 flex flex-col items-center justify-center text-red-700 text-center">
                    <h1 className="text-6xl font-bold mb-4 animate-bounce">O TEMPO ACABOU</h1>
                    <p className="text-2xl text-gray-500">Você agora pertence aos Backrooms.</p>
                    <button 
                        onClick={() => setGameState('MENU')}
                        className="mt-8 px-6 py-3 border-2 border-red-900 text-red-900 hover:bg-red-900 hover:text-black transition-colors"
                    >
                        TENTAR NOVAMENTE
                    </button>
                </div>
            )}

            {/* HUD */}
            {gameState === 'PLAYING' && (
                <>
                    <div className="absolute top-4 right-4 z-40 flex flex-col items-end pointer-events-none">
                        <div className="text-[#d4cd96] font-bold text-2xl font-mono tracking-wider drop-shadow-md">
                            <span className="text-xs mr-2 opacity-70">TEMPO:</span>
                            <span ref={timerRef}>05:00</span>
                        </div>
                        <div className="text-[#d4cd96] font-bold text-sm font-mono tracking-wider opacity-70 mt-1">
                            NÍVEL {level}
                        </div>
                    </div>

                    {/* MOBILE CONTROLS */}
                    <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex gap-8 z-50">
                        <button 
                            id="btn-jump"
                            onClick={jump}
                            className="w-16 h-16 rounded-full border-2 border-[#d4cd96] bg-black/50 text-[#d4cd96] font-bold active:bg-[#d4cd96] active:text-black touch-manipulation"
                        >
                            PULAR
                        </button>
                        <button 
                            id="btn-light"
                            onClick={toggleFlashlight}
                            className={`w-16 h-16 rounded-full border-2 ${flashlightOn ? 'border-yellow-200 bg-yellow-900/50 text-yellow-200' : 'border-gray-500 bg-black/50 text-gray-500'} font-bold active:bg-yellow-200 active:text-black touch-manipulation`}
                        >
                            LUZ
                        </button>
                    </div>
                </>
            )}

            {/* OVERLAYS */}
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-10 shadow-[inset_0_0_150px_rgba(0,0,0,0.8)]" />
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-20 opacity-10" style={SCANLINE_STYLE} />

            {/* JOYSTICK UI */}
            <div className="absolute top-0 left-0 w-full h-full z-30 pointer-events-none">
                <div 
                    ref={joyBaseRef} 
                    className="absolute w-[120px] h-[120px] border-2 border-white/10 rounded-full hidden pointer-events-none"
                >
                    <div 
                        ref={joyStickRef} 
                        className="absolute top-1/2 left-1/2 w-[50px] h-[50px] bg-[rgba(255,255,200,0.3)] rounded-full -translate-x-1/2 -translate-y-1/2 shadow-[0_0_10px_rgba(0,0,0,0.5)]"
                    />
                </div>
            </div>

            {/* GAME CONTAINER */}
            <div ref={mountRef} className="absolute top-0 left-0 w-full h-full z-0" />
        </div>
    );
}

export default function App() {
  useEffect(() => {
    // original AI Studio code executed once
    main();
  }, []);
  return null;
}
