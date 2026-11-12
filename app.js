/* ==========================================================================
   SCRAMBLE CADDIE — Interactive OpenStreetMap Caddie & Conservative Strategy App
   Spotswood Country Club (Harrisonburg, VA)
   ========================================================================== */

(function () {
  'use strict';

  const DATA = window.SPOTSWOOD_DATA;
  if (!DATA) {
    console.error('Missing SPOTSWOOD_DATA');
    return;
  }

  // Application State
  const state = {
    theme: localStorage.getItem('fs_theme') || 'light',
    selectedTeeId: localStorage.getItem('fs_tee') || 'Gold', // Default Gold (recommended conservative high-handicap tee)
    pendingTeeId: localStorage.getItem('fs_tee') || 'Gold',
    currentHoleNum: 1,
    currentShotIdx: 0, // 0 = Shot 1, 1 = Shot 2, 2 = Shot 3
    teammateSafe: false, // "Teammate Safe in Play?" toggle
    mapMode: 'hole-up', // 'hole-up' | 'north-up' | 'course'
    zoom: 1.0,
    panX: 0,
    panY: 0,
    gpsMode: 'sim', // 'sim' | 'live'
    simSpotKey: 'tee', // 'tee' | 'shot1' | 'shot2' | 'green' | 'custom'
    userGpsCoord: null, // [lat, lon]
    liveGpsWatchId: null,
    liveGpsAccuracyYds: null,
    // Scramble Tournament State
    players: JSON.parse(localStorage.getItem('fs_players') || '["Player 1","Player 2","Player 3","Player 4"]'),
    holeScores: JSON.parse(localStorage.getItem('fs_scores') || '{}'), // { 1: 5, ... }
    holeDrivers: JSON.parse(localStorage.getItem('fs_drivers') || '{}') // { 1: 0, ... }
  };

  // Geometry & Math Utilities
  const DEG_TO_RAD = Math.PI / 180;
  const METERS_PER_DEG_LAT = 111320;
  const YARDS_PER_METER = 1.09361;

  function distYds(c1, c2) {
    if (!c1 || !c2) return 0;
    const dy = (c2[0] - c1[0]) * METERS_PER_DEG_LAT;
    const dx = (c2[1] - c1[1]) * METERS_PER_DEG_LAT * Math.cos(c1[0] * DEG_TO_RAD);
    return Math.round(Math.hypot(dx, dy) * YARDS_PER_METER);
  }

  function interpolateCoord(c1, c2, t) {
    return [
      c1[0] + (c2[0] - c1[0]) * t,
      c1[1] + (c2[1] - c1[1]) * t
    ];
  }

  function getActiveHole() {
    return DATA.holes.find((h) => h.number === state.currentHoleNum) || DATA.holes[0];
  }

  function getActiveTeeSet() {
    return DATA.course.teeSets.find((t) => t.id === state.selectedTeeId) || DATA.course.teeSets[4];
  }

  // Dynamically adapt Shot 1 origin & target for the selected tee box
  function getEffectiveShots(hole) {
    const teeCoord = (hole.teeCoords && hole.teeCoords[state.selectedTeeId]) || hole.centerline[0];
    const baseShots = hole.shots;
    const holeYds = hole.yardages[state.selectedTeeId] || hole.yardages.White;
    const blackYds = hole.yardages.Black;

    return baseShots.map((shot, idx) => {
      const cloned = Object.assign({}, shot);
      if (idx === 0) {
        cloned.fromCoord = teeCoord;
        // If playing forward tees (Gold/Orange) on a Par 4/5 where tee moved way up,
        // ensure Shot 1 target is positioned realistically ahead of the forward tee
        if (hole.par >= 4 && holeYds < blackYds - 70) {
          const distToDefaultTarget = distYds(teeCoord, shot.targetCoord);
          const distToGreen = distYds(teeCoord, hole.green.center);
          if (distToDefaultTarget < 110 || distToDefaultTarget > distToGreen - 35) {
            const midOrPin = hole.centerline.length > 2 ? hole.centerline[1] : hole.green.center;
            const ratio = hole.par === 5 ? 0.52 : 0.64;
            cloned.targetCoord = interpolateCoord(teeCoord, hole.green.center, ratio);
            if (distYds(cloned.targetCoord, midOrPin) < 60) {
              cloned.targetCoord = interpolateCoord(cloned.targetCoord, midOrPin, 0.45);
            }
          }
        }
      } else if (idx === 1 && baseShots.length >= 3) {
        // Connect Shot 2 start to Shot 1's effective target
        const prevTarget = idx === 1 ? getEffectiveShot0Target(hole, teeCoord, holeYds, blackYds) : shot.fromCoord;
        cloned.fromCoord = prevTarget;
      }
      return cloned;
    });
  }

  function getEffectiveShot0Target(hole, teeCoord, holeYds, blackYds) {
    const shot0 = hole.shots[0];
    if (hole.par >= 4 && holeYds < blackYds - 70) {
      const distToDefaultTarget = distYds(teeCoord, shot0.targetCoord);
      const distToGreen = distYds(teeCoord, hole.green.center);
      if (distToDefaultTarget < 110 || distToDefaultTarget > distToGreen - 35) {
        const midOrPin = hole.centerline.length > 2 ? hole.centerline[1] : hole.green.center;
        const ratio = hole.par === 5 ? 0.52 : 0.64;
        let tc = interpolateCoord(teeCoord, hole.green.center, ratio);
        if (distYds(tc, midOrPin) < 60) {
          tc = interpolateCoord(tc, midOrPin, 0.45);
        }
        return tc;
      }
    }
    return shot0.targetCoord;
  }

  function syncSimulatorPositionToShot() {
    if (state.gpsMode === 'live') return;
    const hole = getActiveHole();
    const shots = getEffectiveShots(hole);
    const activeShot = shots[Math.min(state.currentShotIdx, shots.length - 1)];

    if (state.currentShotIdx === 0) {
      state.simSpotKey = 'tee';
      state.userGpsCoord = activeShot.fromCoord;
    } else if (state.currentShotIdx === 1 && shots.length === 3) {
      state.simSpotKey = 'shot1';
      state.userGpsCoord = shots[0].targetCoord;
    } else if (state.currentShotIdx === 1 && shots.length === 2) {
      state.simSpotKey = 'green';
      state.userGpsCoord = shots[0].targetCoord;
    } else {
      state.simSpotKey = 'shot2';
      state.userGpsCoord = activeShot.fromCoord;
    }
  }

  // ==========================================================================
  // SVG OpenStreetMap Course & Hole Vector Engine
  // ==========================================================================
  const SVG_W = 800;
  const SVG_H = 620;
  let currentProjection = null;

  function buildProjection(hole) {
    const isCourseMode = state.mapMode === 'course';
    let centerLat, centerLon, rotationRad, baseScale;

    if (isCourseMode) {
      centerLat = 38.42865;
      centerLon = -78.83385;
      rotationRad = 0;
      baseScale = 0.62 * state.zoom;
    } else {
      const teeCoord = (hole.teeCoords && hole.teeCoords[state.selectedTeeId]) || hole.centerline[0];
      const pinCoord = hole.green.center;
      // Bounding center of hole (tee, midpoint, green)
      const allPts = [teeCoord, pinCoord].concat(hole.centerline);
      const minLat = Math.min(...allPts.map((p) => p[0]));
      const maxLat = Math.max(...allPts.map((p) => p[0]));
      const minLon = Math.min(...allPts.map((p) => p[1]));
      const maxLon = Math.max(...allPts.map((p) => p[1]));
      centerLat = (minLat + maxLat) / 2;
      centerLon = (minLon + maxLon) / 2;

      const cosLat = Math.cos(centerLat * DEG_TO_RAD);
      const dxHole = (pinCoord[1] - teeCoord[1]) * METERS_PER_DEG_LAT * cosLat;
      const dyHole = (pinCoord[0] - teeCoord[0]) * METERS_PER_DEG_LAT;
      const holeSpanMeters = Math.max(135, Math.hypot(dxHole, dyHole));

      if (state.mapMode === 'hole-up') {
        // Bearing from tee to pin: angle clockwise from North (+Y)
        rotationRad = Math.atan2(dxHole, dyHole);
      } else {
        rotationRad = 0;
      }

      baseScale = ((SVG_H * 0.66) / holeSpanMeters) * state.zoom;
    }

    const cosLat = Math.cos(centerLat * DEG_TO_RAD);
    const cosR = Math.cos(-rotationRad);
    const sinR = Math.sin(-rotationRad);

    function project(coord) {
      const eastM = (coord[1] - centerLon) * METERS_PER_DEG_LAT * cosLat;
      const northM = (coord[0] - centerLat) * METERS_PER_DEG_LAT;
      // Rotate by -rotationRad so Tee->Green aligns with +North (up on screen)
      const rx = eastM * cosR - northM * sinR;
      const ry = eastM * sinR + northM * cosR;
      const sx = SVG_W / 2 + rx * baseScale + state.panX;
      const sy = SVG_H / 2 - ry * baseScale + state.panY;
      return [sx, sy];
    }

    function unproject(sx, sy) {
      const rx = (sx - SVG_W / 2 - state.panX) / baseScale;
      const ry = -(sy - SVG_H / 2 - state.panY) / baseScale;
      // Inverse rotation (+rotationRad)
      const cosInv = Math.cos(rotationRad);
      const sinInv = Math.sin(rotationRad);
      const eastM = rx * cosInv - ry * sinInv;
      const northM = rx * sinInv + ry * cosInv;
      const lat = centerLat + northM / METERS_PER_DEG_LAT;
      const lon = centerLon + eastM / (METERS_PER_DEG_LAT * cosLat);
      return [Number(lat.toFixed(6)), Number(lon.toFixed(6))];
    }

    function yardsToPx(yds) {
      return (yds / YARDS_PER_METER) * baseScale;
    }

    return {
      project,
      unproject,
      yardsToPx,
      rotationDeg: (-rotationRad * 180) / Math.PI,
      isCourseMode
    };
  }

  function ptsToSvgPath(pts, projectFn, closePath) {
    if (!pts || !pts.length) return '';
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = projectFn(pts[i]);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
    }
    if (closePath) d += 'Z';
    return d;
  }

  function renderMap() {
    const svg = document.getElementById('osmCourseSvg');
    if (!svg) return;

    const hole = getActiveHole();
    const shots = getEffectiveShots(hole);
    const activeShot = shots[Math.min(state.currentShotIdx, shots.length - 1)];
    const proj = buildProjection(hole);
    currentProjection = proj;

    // Update compass arrow rotation
    const compassArrow = document.getElementById('compassArrow');
    if (compassArrow) {
      compassArrow.style.transform = `rotate(${proj.rotationDeg.toFixed(1)}deg)`;
    }

    const geom = DATA.osmGeometry;
    let html = '';

    // SVG Defs for Mowing Stripes, Glows, Markers & Gradients
    html += `
      <defs>
        <pattern id="fairwayMowPattern" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(25)">
          <rect width="9" height="18" fill="var(--map-fairway)" />
          <rect x="9" width="9" height="18" fill="var(--map-fairway-stripe)" />
        </pattern>
        <pattern id="hazardHatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(224,49,36,0.45)" stroke-width="3" />
        </pattern>
        <filter id="softDropShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.32" />
        </filter>
      </defs>
    `;

    // 1. Background Sky / Rough Canvas
    html += `<rect width="${SVG_W}" height="${SVG_H}" fill="var(--map-sky)" />`;

    // 2. Course Boundary Polygon (OSM Way #82747978)
    if (geom.boundary && geom.boundary.length) {
      html += `<path d="${ptsToSvgPath(geom.boundary, proj.project, true)}" fill="var(--map-course-rough)" stroke="var(--map-fairway-outline)" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.92" />`;
    }

    // 3. Surrounding Roads (Country Club Rd, Fairway Dr — Key OB Boundaries!)
    geom.roads.forEach((r) => {
      const d = ptsToSvgPath(r.pts, proj.project, false);
      html += `<path d="${d}" fill="none" stroke="var(--map-road-stroke)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" opacity="0.7" />`;
      html += `<path d="${d}" fill="none" stroke="var(--map-road)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity="0.85" />`;
    });

    // 4. Cart Paths
    geom.cartpaths.forEach((cp) => {
      html += `<path d="${ptsToSvgPath(cp, proj.project, false)}" fill="none" stroke="var(--map-cartpath)" stroke-width="2.2" stroke-dasharray="3,3" stroke-linecap="round" />`;
    });

    // 5. All 21 OSM Fairways (with Multipolygon Inner Cutouts)
    geom.fairways.forEach((fw) => {
      let d = '';
      fw.outer.forEach((ring) => {
        d += ptsToSvgPath(ring, proj.project, true) + ' ';
      });
      fw.inner.forEach((ring) => {
        d += ptsToSvgPath(ring, proj.project, true) + ' ';
      });
      html += `<path d="${d}" fill="url(#fairwayMowPattern)" fill-rule="evenodd" stroke="var(--map-fairway-outline)" stroke-width="1.4" />`;
    });

    // 6. Water Hazard (Hole 15 Right Pond)
    geom.water.forEach((wt) => {
      html += `<path d="${ptsToSvgPath(wt, proj.project, true)}" fill="var(--map-water)" stroke="var(--map-water-Edge)" stroke-width="2" />`;
    });

    // 7. All 47 OSM Tee Boxes
    geom.tees.forEach((tb) => {
      html += `<path d="${ptsToSvgPath(tb, proj.project, true)}" fill="var(--map-fairway-stripe)" stroke="var(--map-green-outline)" stroke-width="1" />`;
    });

    // 8. All 19 OSM Greens
    geom.greens.forEach((gr) => {
      html += `<path d="${ptsToSvgPath(gr, proj.project, true)}" fill="var(--map-green)" stroke="var(--map-green-outline)" stroke-width="2" />`;
    });

    // 9. All 56 OSM Sand Bunkers
    geom.bunkers.forEach((bk) => {
      html += `<path d="${ptsToSvgPath(bk, proj.project, true)}" fill="var(--map-bunker)" stroke="var(--map-bunker-lip)" stroke-width="1.3" />`;
    });

    // 10. Clubhouse Building
    geom.buildings.forEach((bldg) => {
      html += `<path d="${ptsToSvgPath(bldg, proj.project, true)}" fill="#8c7a6b" stroke="#5c4d42" stroke-width="1.5" opacity="0.8" />`;
    });

    // If in 18-Hole Full Course Overview Mode, draw all 18 hole centerlines & interactive hole badges
    if (proj.isCourseMode) {
      DATA.holes.forEach((h) => {
        const isCurrent = h.number === hole.number;
        const dLine = ptsToSvgPath(h.centerline, proj.project, false);
        html += `<path d="${dLine}" fill="none" stroke="${isCurrent ? '#f5b82e' : 'rgba(255,255,255,0.55)'}" stroke-width="${isCurrent ? 3.5 : 1.6}" stroke-dasharray="${isCurrent ? 'none' : '4,4'}" />`;
        const midPt = h.centerline.length > 2 ? h.centerline[1] : interpolateCoord(h.centerline[0], h.centerline[1], 0.5);
        const [mx, my] = proj.project(midPt);
        html += `
          <g class="course-hole-marker" data-jump-hole="${h.number}" style="cursor:pointer;" filter="url(#softDropShadow)">
            <circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="${isCurrent ? 14 : 11}" fill="${isCurrent ? '#d49b27' : '#16462e'}" stroke="#ffffff" stroke-width="2" />
            <text x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" text-anchor="middle" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="${isCurrent ? '11' : '9.5'}" font-weight="800">${h.number}</text>
          </g>
        `;
      });
    } else {
      // ======================================================================
      // Active Hole Strategy Overlays (Centerline, Yardage Arcs, Hazards, Target, GPS)
      // ======================================================================

      // A. Subtle full hole centerline
      html += `<path d="${ptsToSvgPath(hole.centerline, proj.project, false)}" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="2" stroke-dasharray="4,6" />`;

      // B. 100y & 150y Distance-to-Green Reference Rings around Green Center
      const [gx, gy] = proj.project(hole.green.center);
      [100, 150].forEach((ringYds) => {
        const rPx = proj.yardsToPx(ringYds);
        if (rPx > 35 && rPx < 480) {
          html += `
            <circle cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" r="${rPx.toFixed(1)}" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1" stroke-dasharray="3,6" />
          `;
        }
      });

      // C. Red "NO-GO / AVOID" Hazard Zones for this Hole
      hole.hazards.forEach((hz) => {
        const [hx, hy] = proj.project(hz.coord);
        const hr = Math.max(14, proj.yardsToPx(hz.radiusYds || 12));
        html += `
          <g class="hazard-zone-overlay">
            <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="${hr.toFixed(1)}" fill="url(#hazardHatch)" stroke="#e03124" stroke-width="2" stroke-dasharray="4,3" />
            <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="4" fill="#e03124" />
            <g transform="translate(${hx.toFixed(1)}, ${(hy - hr - 8).toFixed(1)})" filter="url(#softDropShadow)">
              <rect x="-68" y="-11" width="136" height="19" rx="5" fill="#b91c1c" stroke="#fca5a5" stroke-width="1" />
              <text x="0" y="2" text-anchor="middle" fill="#ffffff" font-family="Plus Jakarta Sans, sans-serif" font-size="9.5" font-weight="800">⛔ ${hz.label}</text>
            </g>
          </g>
        `;
      });

      // D. Inactive Shot Steps Preview Markers (dimmed breadcrumbs)
      shots.forEach((s, idx) => {
        if (idx === state.currentShotIdx) return;
        const [sx, sy] = proj.project(s.targetCoord);
        html += `
          <g opacity="0.55" style="cursor:pointer;" data-select-shot="${idx}">
            <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="8" fill="#16462e" stroke="#ffffff" stroke-width="1.5" />
            <text x="${sx.toFixed(1)}" y="${(sy + 3.5).toFixed(1)}" text-anchor="middle" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="9" font-weight="700">${idx + 1}</text>
          </g>
        `;
      });

      // E. Active Tee Box Marker for Selected Tee
      const teeCoord = (hole.teeCoords && hole.teeCoords[state.selectedTeeId]) || hole.centerline[0];
      const [tx, ty] = proj.project(teeCoord);
      const teeMeta = getActiveTeeSet();
      html += `
        <g filter="url(#softDropShadow)">
          <circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="8" fill="${teeMeta.color}" stroke="#ffffff" stroke-width="2.2" />
          <text x="${tx.toFixed(1)}" y="${(ty + 21).toFixed(1)}" text-anchor="middle" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="800" style="paint-order:stroke;stroke:#0f291e;stroke-width:3px;">${state.selectedTeeId.toUpperCase()} TEE</text>
        </g>
      `;

      // F. Green Flagstick Marker
      html += `
        <g transform="translate(${gx.toFixed(1)}, ${gy.toFixed(1)})" filter="url(#softDropShadow)">
          <circle cx="0" cy="0" r="4" fill="#ffffff" stroke="#111" stroke-width="1.5" />
          <line x1="0" y1="0" x2="0" y2="-24" stroke="#ffffff" stroke-width="2" />
          <polygon points="0,-24 15,-19 0,-13" fill="#e03124" />
        </g>
      `;

      // G. Active Shot Safe Landing Zone & Trajectory Line from Current Ball Position
      const ballOrigin = state.userGpsCoord || activeShot.fromCoord;
      const [bx, by] = proj.project(ballOrigin);
      const [targX, targY] = proj.project(activeShot.targetCoord);
      const targRadiusPx = Math.max(18, proj.yardsToPx(activeShot.targetRadiusYds || 12));
      const shotYds = distYds(ballOrigin, activeShot.targetCoord);

      // Aim corridor cone + Short & Right Fade Compensation Arc
      const midX = (bx + targX) / 2;
      const midY = (by + targY) / 2;
      const dxVec = targX - bx;
      const dyVec = targY - by;
      const segLen = Math.hypot(dxVec, dyVec);
      // Perpendicular right-hand vector in SVG screen space for a golfer facingbx->targX
      // Forward vector is (dxVec, dyVec); 90-deg clockwise right-hand vector is (-dyVec, dxVec)
      let fadeCurveHtml = '';
      if (segLen > 45 && activeShot.phase !== 'green') {
        const offsetPx = Math.min(26, segLen * 0.14);
        const ctrlX = midX + (-dyVec / segLen) * offsetPx * -0.85; // Start left of target line, curve right into target
        const ctrlY = midY + (dxVec / segLen) * offsetPx * -0.85;
        fadeCurveHtml = `
          <path d="M ${bx.toFixed(1)},${by.toFixed(1)} Q ${ctrlX.toFixed(1)},${ctrlY.toFixed(1)} ${targX.toFixed(1)},${targY.toFixed(1)}" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-dasharray="4,4" opacity="0.85" />
        `;
      }

      html += `
        <line x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${targX.toFixed(1)}" y2="${targY.toFixed(1)}" stroke="rgba(245, 184, 46, 0.28)" stroke-width="10" stroke-linecap="round" />
        <line x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${targX.toFixed(1)}" y2="${targY.toFixed(1)}" stroke="#f5b82e" stroke-width="3" stroke-dasharray="7,5" stroke-linecap="round" />
        ${fadeCurveHtml}
      `;

      // Safe Target Zone Bullseye
      const ringColor = state.teammateSafe ? '#22c55e' : '#f5b82e';
      html += `
        <g filter="url(#softDropShadow)">
          <circle cx="${targX.toFixed(1)}" cy="${targY.toFixed(1)}" r="${targRadiusPx.toFixed(1)}" fill="rgba(245, 184, 46, 0.22)" stroke="${ringColor}" stroke-width="2.5" />
          <circle cx="${targX.toFixed(1)}" cy="${targY.toFixed(1)}" r="6" fill="${ringColor}" stroke="#ffffff" stroke-width="2" />
          <g transform="translate(${targX.toFixed(1)}, ${(targY - targRadiusPx - 12).toFixed(1)})">
            <rect x="-82" y="-12" width="164" height="22" rx="6" fill="#143d29" stroke="${ringColor}" stroke-width="1.5" />
            <text x="0" y="3" text-anchor="middle" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="10" font-weight="800">🎯 ${shotYds}Y · ${activeShot.targetLabel.slice(0, 18)}</text>
          </g>
        </g>
      `;

      // H. User GPS / Simulated Golfer Position Marker ("YOU")
      html += `
        <g transform="translate(${bx.toFixed(1)}, ${by.toFixed(1)})" filter="url(#softDropShadow)">
          <circle cx="0" cy="0" r="14" fill="rgba(37, 99, 235, 0.25)" />
          <circle cx="0" cy="0" r="7.5" fill="#2563eb" stroke="#ffffff" stroke-width="2.5" />
          <rect x="-24" y="11" width="48" height="16" rx="4" fill="#1e3a8a" stroke="#93c5fd" stroke-width="1" />
          <text x="0" y="22" text-anchor="middle" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="8.5" font-weight="800">${state.gpsMode === 'live' ? 'GPS' : 'YOU'}</text>
        </g>
      `;
    }

    svg.innerHTML = html;

    // Bind SVG click listeners for hole badges (in 18-hole mode) or shot breadcrumbs
    svg.querySelectorAll('[data-jump-hole]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const hNum = parseInt(el.getAttribute('data-jump-hole'), 10);
        selectHole(hNum);
        setMapMode('hole-up');
      });
    });

    svg.querySelectorAll('[data-select-shot]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const sIdx = parseInt(el.getAttribute('data-select-shot'), 10);
        selectShotStep(sIdx);
      });
    });
  }

  // ==========================================================================
  // UI Rendering & Synchronization
  // ==========================================================================
  function renderHoleRibbon() {
    const container = document.getElementById('holeRibbonList');
    if (!container) return;
    let html = '';
    DATA.holes.forEach((h) => {
      const isActive = h.number === state.currentHoleNum;
      const hasScore = state.holeScores[h.number] !== undefined;
      html += `
        <button type="button" class="hole-pill ${isActive ? 'active' : ''}" role="tab" aria-selected="${isActive}" id="holePillBtn_${h.number}" data-hole-num="${h.number}">
          <span class="hole-pill-num">${h.number}</span>
          <span class="hole-pill-par">P${h.par}</span>
          ${hasScore ? '<span class="hole-pill-score-dot" title="Score recorded"></span>' : ''}
        </button>
      `;
    });
    container.innerHTML = html;

    container.querySelectorAll('.hole-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        const num = parseInt(btn.getAttribute('data-hole-num'), 10);
        selectHole(num);
      });
    });

    // Scroll active pill into view smoothly
    const activeBtn = document.getElementById(`holePillBtn_${state.currentHoleNum}`);
    if (activeBtn && activeBtn.scrollIntoView) {
      activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }

  function renderHeaderTeeBadge() {
    const teeSet = getActiveTeeSet();
    const dot = document.getElementById('activeTeeDot');
    const teeLabel = document.getElementById('activeTeeLabel');
    if (dot) dot.style.background = teeSet.color;
    if (teeLabel) {
      teeLabel.textContent = `${teeSet.id} · ${teeSet.totalYds.toLocaleString()} yds`;
    }
  }

  function renderRangefinderHud() {
    const hole = getActiveHole();
    const shots = getEffectiveShots(hole);
    const activeShot = shots[Math.min(state.currentShotIdx, shots.length - 1)];
    const userPos = state.userGpsCoord || activeShot.fromCoord;

    const toTarget = distYds(userPos, activeShot.targetCoord);
    const toFront = distYds(userPos, hole.green.front);
    const toCenter = distYds(userPos, hole.green.center);
    const toBack = distYds(userPos, hole.green.back);

    document.getElementById('hudTargetEyebrow').textContent =
      activeShot.phase === 'green' ? 'TO HOLE / PIN' : `SHOT ${activeShot.step} SAFE TARGET`;
    document.getElementById('hudToTargetYds').textContent = toTarget;
    document.getElementById('hudFrontYds').textContent = toFront;
    document.getElementById('hudCenterYds').textContent = toCenter;
    document.getElementById('hudBackYds').textContent = toBack;

    // Update GPS status readout bar
    const readout = document.getElementById('gpsStatusReadout');
    if (state.gpsMode === 'live') {
      readout.textContent = `Live GPS Active (±${state.liveGpsAccuracyYds || 4} yds) — Distances from your real location`;
    } else {
      const spotLabels = {
        tee: `Simulating from ${state.selectedTeeId} Tee Box (tap map to move ball)`,
        shot1: 'Simulating from Shot 1 Landing Zone (tap map to move ball)',
        shot2: 'Simulating from Layup / Approach Spot (tap map to move ball)',
        green: 'Simulating Greenside Position (tap map to move ball)',
        custom: `Custom Map Spot Selected (${toCenter} yds to center of green)`
      };
      readout.textContent = spotLabels[state.simSpotKey] || spotLabels.tee;
    }

    document.querySelectorAll('#gpsPresetBtnsGroup .gps-preset-btn').forEach((btn) => {
      btn.classList.toggle('active', state.gpsMode === 'sim' && btn.getAttribute('data-sim-spot') === state.simSpotKey);
    });
  }

  function renderPlaybook() {
    const hole = getActiveHole();
    const shots = getEffectiveShots(hole);
    const shotIdx = Math.min(state.currentShotIdx, shots.length - 1);
    const activeShot = shots[shotIdx];
    const holeYds = hole.yardages[state.selectedTeeId] || hole.yardages.White;

    // 1. Hole Identity Card
    document.getElementById('holeNumberTitle').textContent = `Hole ${hole.number}`;
    document.getElementById('holeNicknameTitle').textContent = `“${hole.nickname}”`;
    document.getElementById('holeHeadlineTag').textContent = hole.headline;
    document.getElementById('holeParVal').textContent = hole.par;
    document.getElementById('holeTeeNameMini').textContent = state.selectedTeeId.toUpperCase();
    document.getElementById('holeYardageVal').textContent = `${holeYds}y`;
    document.getElementById('holeHandicapVal').textContent = hole.mensHandicap;
    document.getElementById('holeOverviewText').textContent = hole.overview;

    // 2. Scramble Safe-Ball Mode Banner
    const banner = document.getElementById('scrambleBannerBox');
    const switchBtn = document.getElementById('toggleSafeBallBtn');
    const statusIcon = document.getElementById('safeBallStatusIcon');
    const statusTitle = document.getElementById('safeBallStatusTitle');
    const statusDesc = document.getElementById('safeBallStatusDesc');
    const btnText = document.getElementById('safeBallBtnText');

    banner.classList.toggle('safe-ball-active', state.teammateSafe);
    switchBtn.classList.toggle('active', state.teammateSafe);
    switchBtn.setAttribute('aria-pressed', String(state.teammateSafe));

    if (state.teammateSafe) {
      statusIcon.textContent = '🟢';
      statusTitle.textContent = 'Scramble Green-Light Mode (Teammate Safe!)';
      statusDesc.textContent = 'A teammate already has a safe ball in play—guidance upgraded to smart aggressive.';
      btnText.textContent = 'Teammate Safe: ON';
    } else {
      statusIcon.textContent = '🛡️';
      statusTitle.textContent = 'Ultra-Conservative Fairway-Finder Mode';
      statusDesc.textContent = 'Zero-risk guidance to get a guaranteed ball in play. Toggle ON once a teammate is safe.';
      btnText.textContent = 'Teammate Safe: OFF';
    }

    // 3. Shot Stepper Tabs
    const tabsHeader = document.getElementById('shotTabsHeader');
    tabsHeader.innerHTML = shots
      .map((s, idx) => {
        const isAct = idx === shotIdx;
        const parts = s.label.split('·');
        return `
          <button type="button" class="shot-tab-btn ${isAct ? 'active' : ''}" role="tab" aria-selected="${isAct}" data-shot-idx="${idx}" id="shotTabBtn_${idx}">
            <span class="shot-tab-step">${parts[0].trim()}</span>
            <span class="shot-tab-name">${(parts[1] || s.phase).trim()}</span>
          </button>
        `;
      })
      .join('');

    tabsHeader.querySelectorAll('.shot-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-shot-idx'), 10);
        selectShotStep(idx);
      });
    });

    // 4. Active Shot Directive Content
    const userPos = state.userGpsCoord || activeShot.fromCoord;
    const shotDist = distYds(userPos, activeShot.targetCoord);

    document.getElementById('activeShotTargetBadge').textContent = `🎯 Target: ${activeShot.targetLabel}`;
    document.getElementById('activeShotDistanceReadout').textContent =
      activeShot.phase === 'green' && shotDist < 25
        ? `Green Depth: ${hole.green.depthYds} yds`
        : `Distance to Target: ${shotDist} yds`;

    const commandEyebrow = document.getElementById('commandModeEyebrow');
    const commandMain = document.getElementById('activeShotCommandText');
    if (state.teammateSafe && activeShot.scrambleSafe) {
      commandEyebrow.textContent = '🟢 SCRAMBLE UPGRADE — TEAMMATE BALL IS SAFE';
      commandMain.textContent = activeShot.scrambleSafe;
    } else {
      commandEyebrow.textContent = '🛡️ THE CONSERVATIVE PLAY — ZERO DECISIONS';
      commandMain.textContent = activeShot.command;
    }

    // Dynamic Club Suggestion tailored to the live shot yardage
    const clubIconBadge = document.getElementById('activeClubBadgeIcon');
    const clubRecText = document.getElementById('activeShotClubText');
    if (activeShot.phase === 'green' && shotDist < 30) {
      clubIconBadge.textContent = 'PT';
      clubRecText.textContent = activeShot.club;
    } else {
      clubIconBadge.textContent = `${shotDist}y`;
      clubRecText.textContent = `${activeShot.club} (Plays ~${shotDist} yds from here)`;
    }

    const shortRightEl = document.getElementById('activeShotShortRightText');
    if (shortRightEl) {
      shortRightEl.textContent =
        activeShot.shortRightFix ||
        'Aim down the left-center side of the target and take 1 extra club to compensate for a short-and-right miss.';
    }

    document.getElementById('activeShotAvoidText').textContent = activeShot.avoid;
    document.getElementById('activeShotWhyText').textContent = activeShot.why;

    const revSourceEl = document.getElementById('holeReviewSourceTag');
    const revQuoteEl = document.getElementById('holeReviewQuoteText');
    if (revSourceEl && hole.reviewSource) {
      revSourceEl.textContent = hole.reviewSource;
    }
    if (revQuoteEl && hole.reviewQuote) {
      revQuoteEl.textContent = hole.reviewQuote;
    }

    // 5. Stepper Footer Navigation
    const prevBtn = document.getElementById('prevShotStepBtn');
    const nextBtn = document.getElementById('nextShotStepBtn');
    const stepIndicator = document.getElementById('shotStepIndicatorText');

    prevBtn.disabled = shotIdx === 0;
    stepIndicator.textContent = `Shot ${shotIdx + 1} of ${shots.length}`;
    if (shotIdx < shots.length - 1) {
      nextBtn.textContent = `Next: Shot ${shotIdx + 2} →`;
    } else if (hole.number < 18) {
      nextBtn.textContent = `Finish Hole ${hole.number} → Hole ${hole.number + 1}`;
    } else {
      nextBtn.textContent = 'View Final Scramble Card 🏆';
    }

    // 6. Quick Scramble Hole Logger
    renderQuickScrambleLogger(hole);
  }

  function renderQuickScrambleLogger(hole) {
    document.getElementById('quickLogHoleLabel').textContent = `Hole ${hole.number} (Par ${hole.par})`;
    document.getElementById('quickLogGreenNote').textContent = hole.greenSlope;

    const scoreRow = document.getElementById('quickScoreBtnRow');
    const currentScore = state.holeScores[hole.number];
    const scoreOptions = [
      { label: 'Eagle', val: hole.par - 2 },
      { label: 'Birdie', val: hole.par - 1 },
      { label: 'Par', val: hole.par },
      { label: 'Bogey', val: hole.par + 1 }
    ];

    scoreRow.innerHTML = scoreOptions
      .map(
        (opt) => `
        <button type="button" class="mini-choice-btn ${currentScore === opt.val ? 'selected' : ''}" data-log-score="${opt.val}">
          ${opt.label} (${opt.val})
        </button>
      `
      )
      .join('');

    scoreRow.querySelectorAll('[data-log-score]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = parseInt(btn.getAttribute('data-log-score'), 10);
        if (state.holeScores[hole.number] === val) {
          delete state.holeScores[hole.number];
        } else {
          state.holeScores[hole.number] = val;
        }
        localStorage.setItem('fs_scores', JSON.stringify(state.holeScores));
        updateHeaderScrambleScore();
        renderHoleRibbon();
        renderQuickScrambleLogger(hole);
      });
    });

    const driverRow = document.getElementById('quickDriverBtnRow');
    const currentDriver = state.holeDrivers[hole.number];
    driverRow.innerHTML = state.players
      .map(
        (pName, pIdx) => `
        <button type="button" class="mini-choice-btn ${currentDriver === pIdx ? 'selected' : ''}" data-log-driver="${pIdx}">
          ${pName.slice(0, 8)}
        </button>
      `
      )
      .join('');

    driverRow.querySelectorAll('[data-log-driver]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pIdx = parseInt(btn.getAttribute('data-log-driver'), 10);
        if (state.holeDrivers[hole.number] === pIdx) {
          delete state.holeDrivers[hole.number];
        } else {
          state.holeDrivers[hole.number] = pIdx;
        }
        localStorage.setItem('fs_drivers', JSON.stringify(state.holeDrivers));
        renderQuickScrambleLogger(hole);
      });
    });
  }

  function updateHeaderScrambleScore() {
    let diff = 0;
    let holesPlayed = 0;
    DATA.holes.forEach((h) => {
      const sc = state.holeScores[h.number];
      if (sc !== undefined) {
        diff += sc - h.par;
        holesPlayed++;
      }
    });
    const diffStr = diff === 0 ? 'E' : diff > 0 ? `+${diff}` : `${diff}`;
    const pill = document.getElementById('headerTeamScorePill');
    if (pill) {
      pill.textContent = holesPlayed === 0 ? 'E (0)' : `${diffStr} (${holesPlayed})`;
    }
  }

  // ==========================================================================
  // Actions & Navigation Handlers
  // ==========================================================================
  function selectHole(holeNum) {
    state.currentHoleNum = Math.max(1, Math.min(18, holeNum));
    state.currentShotIdx = 0;
    state.teammateSafe = false;
    state.zoom = 1.0;
    state.panX = 0;
    state.panY = 0;
    syncSimulatorPositionToShot();
    renderAll();
  }

  function selectShotStep(shotIdx) {
    const hole = getActiveHole();
    const shots = getEffectiveShots(hole);
    state.currentShotIdx = Math.max(0, Math.min(shots.length - 1, shotIdx));
    syncSimulatorPositionToShot();
    renderPlaybook();
    renderRangefinderHud();
    renderMap();
  }

  function setMapMode(mode) {
    state.mapMode = mode;
    state.zoom = 1.0;
    state.panX = 0;
    state.panY = 0;
    document.getElementById('viewModeHoleUpBtn').classList.toggle('active', mode === 'hole-up');
    document.getElementById('viewModeNorthUpBtn').classList.toggle('active', mode === 'north-up');
    document.getElementById('viewModeCourseBtn').classList.toggle('active', mode === 'course');
    renderMap();
  }

  function setSimPresetSpot(spotKey) {
    state.gpsMode = 'sim';
    document.getElementById('requestLiveGpsBtn').classList.remove('active-gps');
    document.getElementById('gpsButtonLabel').textContent = 'Locate Me (GPS)';

    const hole = getActiveHole();
    const shots = getEffectiveShots(hole);
    state.simSpotKey = spotKey;

    if (spotKey === 'tee') {
      state.currentShotIdx = 0;
      state.userGpsCoord = shots[0].fromCoord;
    } else if (spotKey === 'shot1') {
      state.currentShotIdx = Math.min(1, shots.length - 1);
      state.userGpsCoord = shots[0].targetCoord;
    } else if (spotKey === 'shot2') {
      state.currentShotIdx = Math.min(shots.length - 1, 2);
      state.userGpsCoord = shots[Math.min(1, shots.length - 1)].targetCoord;
    } else if (spotKey === 'green') {
      state.currentShotIdx = shots.length - 1;
      state.userGpsCoord = hole.green.front;
    }
    renderPlaybook();
    renderRangefinderHud();
    renderMap();
  }

  // Real Browser Geolocation Handler
  function toggleLiveGps() {
    const btn = document.getElementById('requestLiveGpsBtn');
    const label = document.getElementById('gpsButtonLabel');

    if (state.gpsMode === 'live') {
      if (state.liveGpsWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(state.liveGpsWatchId);
      }
      state.liveGpsWatchId = null;
      state.gpsMode = 'sim';
      btn.classList.remove('active-gps');
      label.textContent = 'Locate Me (GPS)';
      syncSimulatorPositionToShot();
      renderRangefinderHud();
      renderMap();
      return;
    }

    if (!navigator.geolocation) {
      document.getElementById('gpsStatusReadout').textContent =
        'Browser Geolocation unavailable — tap anywhere on the map to simulate GPS position.';
      return;
    }

    label.textContent = 'Locating GPS...';
    state.liveGpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const accYds = Math.round((pos.coords.accuracy || 5) * YARDS_PER_METER);
        state.liveGpsAccuracyYds = accYds;

        const distFromCourse = distYds([lat, lon], DATA.course.center);
        if (distFromCourse <= 2500) {
          // User is physically at Spotswood Country Club!
          state.gpsMode = 'live';
          state.userGpsCoord = [lat, lon];
          btn.classList.add('active-gps');
          label.textContent = `Live GPS (±${accYds}y)`;
        } else {
          // User is testing remotely off-course — lock GPS onto active hole tee & notify clearly
          state.gpsMode = 'live';
          const hole = getActiveHole();
          const shots = getEffectiveShots(hole);
          state.userGpsCoord = shots[state.currentShotIdx].fromCoord;
          btn.classList.add('active-gps');
          label.textContent = 'GPS Demo Locked';
          document.getElementById('gpsStatusReadout').textContent =
            `GPS acquired (${Math.round(distFromCourse / 1760)} mi from Harrisonburg, VA) — snapped to Hole ${hole.number} for on-course preview!`;
        }
        renderPlaybook();
        renderRangefinderHud();
        renderMap();
      },
      () => {
        state.gpsMode = 'sim';
        btn.classList.remove('active-gps');
        label.textContent = 'GPS Sim Active';
        document.getElementById('gpsStatusReadout').textContent =
          'GPS permission declined or unavailable — tap any point on the map to simulate your ball position.';
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 8000 }
    );
  }

  // ==========================================================================
  // Modals: Course/Tee Selection & Scramble Tracker
  // ==========================================================================
  function renderTeeModalOptions() {
    const grid = document.getElementById('teeOptionsGrid');
    if (!grid) return;
    grid.innerHTML = DATA.course.teeSets
      .map((t) => {
        const isSel = t.id === state.pendingTeeId;
        return `
          <button type="button" class="tee-option-card ${isSel ? 'selected' : ''}" data-select-tee="${t.id}">
            <div class="tee-card-top">
              <span class="tee-card-name">
                <span class="tee-swatch-dot" style="background:${t.color};"></span>
                ${t.name}
              </span>
              <span class="tee-card-yds">${t.totalYds.toLocaleString()} yds</span>
            </div>
            <span class="tee-card-badge">${t.badge} · Rating ${t.rating} / Slope ${t.slope}</span>
            <span class="tee-card-rec">${t.recommendedFor}</span>
          </button>
        `;
      })
      .join('');

    grid.querySelectorAll('[data-select-tee]').forEach((card) => {
      card.addEventListener('click', () => {
        state.pendingTeeId = card.getAttribute('data-select-tee');
        renderTeeModalOptions();
      });
    });
  }

  function renderScrambleModalContent() {
    const quotaGrid = document.getElementById('scrambleQuotaGrid');
    const driveCounts = [0, 0, 0, 0];
    Object.values(state.holeDrivers).forEach((pIdx) => {
      if (driveCounts[pIdx] !== undefined) driveCounts[pIdx]++;
    });

    quotaGrid.innerHTML = state.players
      .map((name, idx) => {
        const used = driveCounts[idx];
        const minReq = 3;
        const pct = Math.min(100, Math.round((used / minReq) * 100));
        return `
          <div class="quota-player-card">
            <input type="text" class="quota-player-input" data-player-idx="${idx}" value="${name}" aria-label="Player ${idx + 1} Name" />
            <div style="display:flex;justify-content:space-between;font-size:0.75rem;font-family:var(--font-mono);font-weight:700;">
              <span>Drives Used:</span>
              <span style="color:${used >= minReq ? 'var(--safe-emerald)' : 'var(--brand-brass)'};">${used} / ${minReq} min</span>
            </div>
            <div class="quota-bar-track">
              <div class="quota-bar-fill" style="width:${pct}%;"></div>
            </div>
          </div>
        `;
      })
      .join('');

    quotaGrid.querySelectorAll('.quota-player-input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const idx = parseInt(inp.getAttribute('data-player-idx'), 10);
        state.players[idx] = inp.value.trim() || `Player ${idx + 1}`;
        localStorage.setItem('fs_players', JSON.stringify(state.players));
        renderQuickScrambleLogger(getActiveHole());
      });
    });

    const table = document.getElementById('scrambleFullTable');
    let thHoles = '<tr><th style="text-align:left;padding:6px;">Hole</th>';
    let trPar = '<tr><td style="padding:6px;font-weight:700;">Par</td>';
    let trScore = '<tr><td style="padding:6px;font-weight:700;">Team</td>';
    let trDriver = '<tr><td style="padding:6px;font-weight:700;">Drive</td>';

    DATA.holes.forEach((h) => {
      const sc = state.holeScores[h.number];
      const dr = state.holeDrivers[h.number];
      thHoles += `<th style="padding:5px;text-align:center;border-bottom:1px solid var(--border-subtle);">${h.number}</th>`;
      trPar += `<td style="padding:5px;text-align:center;color:var(--text-muted);">${h.par}</td>`;
      trScore += `<td style="padding:5px;text-align:center;font-weight:800;color:${sc && sc < h.par ? 'var(--safe-emerald)' : 'inherit'};">${sc !== undefined ? sc : '–'}</td>`;
      trDriver += `<td style="padding:5px;text-align:center;font-size:0.7rem;">${dr !== undefined ? state.players[dr].slice(0, 3) : '–'}</td>`;
    });

    thHoles += '</tr>';
    trPar += '</tr>';
    trScore += '</tr>';
    trDriver += '</tr>';
    table.innerHTML = `<thead>${thHoles}</thead><tbody>${trPar}${trScore}${trDriver}</tbody>`;
  }

  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('fs_theme', theme);
    const icon = document.getElementById('themeIcon');
    const text = document.getElementById('themeText');
    if (theme === 'dark') {
      icon.textContent = '🌙';
      text.textContent = 'Night HUD';
    } else {
      icon.textContent = '☀️';
      text.textContent = 'Daylight';
    }
    renderMap();
  }

  function renderAll() {
    renderHeaderTeeBadge();
    renderHoleRibbon();
    renderPlaybook();
    renderRangefinderHud();
    renderMap();
    updateHeaderScrambleScore();
  }

  // ==========================================================================
  // Event Listeners & Initialization
  // ==========================================================================
  function initEvents() {
    // Theme toggle
    document.getElementById('toggleThemeBtn').addEventListener('click', () => {
      applyTheme(state.theme === 'light' ? 'dark' : 'light');
    });

    // Prev / Next Hole buttons
    document.getElementById('prevHoleBtn').addEventListener('click', () => {
      selectHole(state.currentHoleNum > 1 ? state.currentHoleNum - 1 : 18);
    });
    document.getElementById('nextHoleBtn').addEventListener('click', () => {
      selectHole(state.currentHoleNum < 18 ? state.currentHoleNum + 1 : 1);
    });

    // Map camera orientation buttons
    document.getElementById('viewModeHoleUpBtn').addEventListener('click', () => setMapMode('hole-up'));
    document.getElementById('viewModeNorthUpBtn').addEventListener('click', () => setMapMode('north-up'));
    document.getElementById('viewModeCourseBtn').addEventListener('click', () => setMapMode('course'));

    // Map Zoom & Reset
    document.getElementById('zoomInMapBtn').addEventListener('click', () => {
      state.zoom = Math.min(2.6, state.zoom * 1.25);
      renderMap();
    });
    document.getElementById('zoomOutMapBtn').addEventListener('click', () => {
      state.zoom = Math.max(0.65, state.zoom / 1.25);
      renderMap();
    });
    document.getElementById('resetMapCamBtn').addEventListener('click', () => {
      state.zoom = 1.0;
      state.panX = 0;
      state.panY = 0;
      renderMap();
    });

    // Interactive SVG Map Pan & Tap-to-Move Simulated GPS Ball
    const svg = document.getElementById('osmCourseSvg');
    let isPointerDown = false;
    let pointerMoved = false;
    let startX = 0;
    let startY = 0;

    svg.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-jump-hole]') || e.target.closest('[data-select-shot]')) return;
      isPointerDown = true;
      pointerMoved = false;
      startX = e.clientX;
      startY = e.clientY;
    });

    window.addEventListener('pointermove', (e) => {
      if (!isPointerDown) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > 6) {
        pointerMoved = true;
        state.panX += dx;
        state.panY += dy;
        startX = e.clientX;
        startY = e.clientY;
        renderMap();
      }
    });

    window.addEventListener('pointerup', (e) => {
      if (!isPointerDown) return;
      isPointerDown = false;
      if (!pointerMoved && currentProjection && !currentProjection.isCourseMode) {
        const rect = svg.getBoundingClientRect();
        if (
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        ) {
          const sx = ((e.clientX - rect.left) / rect.width) * SVG_W;
          const sy = ((e.clientY - rect.top) / rect.height) * SVG_H;
          state.gpsMode = 'sim';
          state.simSpotKey = 'custom';
          state.userGpsCoord = currentProjection.unproject(sx, sy);
          renderPlaybook();
          renderRangefinderHud();
          renderMap();
        }
      }
    });

    // GPS Simulator Preset Spot Buttons
    document.querySelectorAll('#gpsPresetBtnsGroup .gps-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        setSimPresetSpot(btn.getAttribute('data-sim-spot'));
      });
    });

    // Live GPS Button
    document.getElementById('requestLiveGpsBtn').addEventListener('click', toggleLiveGps);

    // Scramble "Teammate Safe in Play?" Toggle
    document.getElementById('toggleSafeBallBtn').addEventListener('click', () => {
      state.teammateSafe = !state.teammateSafe;
      renderPlaybook();
      renderMap();
    });

    // Shot Stepper Prev / Next Buttons
    document.getElementById('prevShotStepBtn').addEventListener('click', () => {
      if (state.currentShotIdx > 0) {
        selectShotStep(state.currentShotIdx - 1);
      }
    });
    document.getElementById('nextShotStepBtn').addEventListener('click', () => {
      const hole = getActiveHole();
      const shots = getEffectiveShots(hole);
      if (state.currentShotIdx < shots.length - 1) {
        selectShotStep(state.currentShotIdx + 1);
      } else if (state.currentHoleNum < 18) {
        selectHole(state.currentHoleNum + 1);
      } else {
        openScrambleModal();
      }
    });

    // Course & Tee Modal
    const courseModal = document.getElementById('courseTeeModal');
    document.getElementById('openCourseTeeModalBtn').addEventListener('click', () => {
      state.pendingTeeId = state.selectedTeeId;
      renderTeeModalOptions();
      courseModal.classList.add('open');
    });
    document.getElementById('closeCourseTeeModalBtn').addEventListener('click', () => {
      courseModal.classList.remove('open');
    });
    document.getElementById('confirmTeeSelectionBtn').addEventListener('click', () => {
      state.selectedTeeId = state.pendingTeeId;
      localStorage.setItem('fs_tee', state.selectedTeeId);
      syncSimulatorPositionToShot();
      courseModal.classList.remove('open');
      renderAll();
    });

    // Scramble Scorecard Modal
    const scrambleModal = document.getElementById('scrambleModal');
    function openScrambleModal() {
      renderScrambleModalContent();
      scrambleModal.classList.add('open');
    }
    document.getElementById('openScrambleModalBtn').addEventListener('click', openScrambleModal);
    document.getElementById('closeScrambleModalBtn').addEventListener('click', () => {
      scrambleModal.classList.remove('open');
    });
    document.getElementById('doneScrambleModalBtn').addEventListener('click', () => {
      scrambleModal.classList.remove('open');
    });
    document.getElementById('resetScrambleCardBtn').addEventListener('click', () => {
      state.holeScores = {};
      state.holeDrivers = {};
      localStorage.removeItem('fs_scores');
      localStorage.removeItem('fs_drivers');
      renderScrambleModalContent();
      renderAll();
    });

    // ========================================================================
    // Mobile PWA Features: Screen Wake Lock, Share/Install Modal & Service Worker
    // ========================================================================
    let wakeLockSentinel = null;
    let wakeLockEnabled = false;
    const wakeBtn = document.getElementById('toggleWakeLockBtn');
    const wakeText = document.getElementById('wakeLockText');

    async function requestWakeLock() {
      if (!('wakeLock' in navigator)) {
        wakeLockEnabled = !wakeLockEnabled;
        if (wakeBtn) wakeBtn.classList.toggle('active-wakelock', wakeLockEnabled);
        if (wakeText) wakeText.textContent = wakeLockEnabled ? 'Keep Awake: ON' : 'Keep Awake: OFF';
        return;
      }
      try {
        if (!wakeLockEnabled) {
          wakeLockSentinel = await navigator.wakeLock.request('screen');
          wakeLockEnabled = true;
          if (wakeBtn) wakeBtn.classList.add('active-wakelock');
          if (wakeText) wakeText.textContent = 'Keep Awake: ON';
          wakeLockSentinel.addEventListener('release', () => {
            if (!document.hidden) {
              wakeLockEnabled = false;
              if (wakeBtn) wakeBtn.classList.remove('active-wakelock');
              if (wakeText) wakeText.textContent = 'Keep Awake: OFF';
            }
          });
        } else {
          if (wakeLockSentinel) await wakeLockSentinel.release();
          wakeLockSentinel = null;
          wakeLockEnabled = false;
          if (wakeBtn) wakeBtn.classList.remove('active-wakelock');
          if (wakeText) wakeText.textContent = 'Keep Awake: OFF';
        }
      } catch (_err) {
        wakeLockEnabled = !wakeLockEnabled;
        if (wakeBtn) wakeBtn.classList.toggle('active-wakelock', wakeLockEnabled);
        if (wakeText) wakeText.textContent = wakeLockEnabled ? 'Keep Awake: ON' : 'Keep Awake: OFF';
      }
    }

    if (wakeBtn) {
      wakeBtn.addEventListener('click', requestWakeLock);
    }

    document.addEventListener('visibilitychange', async () => {
      if (wakeLockEnabled && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
        try {
          wakeLockSentinel = await navigator.wakeLock.request('screen');
        } catch (_e) {}
      }
    });

    // Install Prompt Handling (Android / Chrome PWA)
    let deferredInstallPrompt = null;
    const nativeInstallWrap = document.getElementById('nativeInstallPromptWrap');
    const triggerInstallBtn = document.getElementById('triggerNativeInstallBtn');

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (nativeInstallWrap) nativeInstallWrap.style.display = 'block';
    });

    if (triggerInstallBtn) {
      triggerInstallBtn.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        if (nativeInstallWrap) nativeInstallWrap.style.display = 'none';
      });
    }

    // Share & Install Phone App Modal
    const shareModal = document.getElementById('shareInstallModal');
    function renderShareModalQr() {
      const url = window.location.href.startsWith('http')
        ? window.location.href
        : 'https://scramble-caddie.netlify.app';
      const urlDisplay = document.getElementById('shareUrlShortDisplay');
      if (urlDisplay) urlDisplay.textContent = url.replace(/^https?:\/\//, '');

      const qrWrap = document.getElementById('shareQrCanvasWrap');
      if (!qrWrap) return;
      // Render high-contrast scannable QR + quick-share badge
      const encodedUrl = encodeURIComponent(url);
      qrWrap.innerHTML = `
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=140x140&margin=2&color=102c1f&Data=${encodedUrl}"
             alt="QR Code for ${url}"
             width="140" height="140"
             style="display:block;border-radius:6px;"
             onerror="this.style.display='none';this.nextElementSibling.style.display='grid';" />
        <div style="display:none;place-items:center;width:140px;height:140px;background:#16462e;color:#fff;border-radius:6px;padding:10px;font-size:11px;font-weight:700;text-align:center;">
          📲 Tap "Share Link" or "Copy Link" to text to your group!
        </div>
      `;
    }

    const openShareBtn = document.getElementById('openShareInstallModalBtn');
    if (openShareBtn && shareModal) {
      openShareBtn.addEventListener('click', () => {
        renderShareModalQr();
        shareModal.classList.add('open');
      });
      document.getElementById('closeShareInstallModalBtn').addEventListener('click', () => {
        shareModal.classList.remove('open');
      });
      document.getElementById('doneShareInstallModalBtn').addEventListener('click', () => {
        shareModal.classList.remove('open');
      });
    }

    const nativeShareBtn = document.getElementById('nativeShareBtn');
    if (nativeShareBtn) {
      nativeShareBtn.addEventListener('click', async () => {
        const shareData = {
          title: 'Scramble Caddie — Spotswood CC Strategy & GPS',
          text: 'Open our Scramble Caddie GPS & hole-by-hole strategy map for Spotswood Country Club:',
          url: window.location.href
        };
        if (navigator.share) {
          try {
            await navigator.share(shareData);
          } catch (_e) {}
        } else if (navigator.clipboard) {
          await navigator.clipboard.writeText(window.location.href);
          nativeShareBtn.textContent = '✅ Link Copied!';
          setTimeout(() => {
            nativeShareBtn.textContent = '📤 Share Link to Group';
          }, 2200);
        }
      });
    }

    const copyUrlBtn = document.getElementById('copyAppUrlBtn');
    if (copyUrlBtn) {
      copyUrlBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(window.location.href);
          copyUrlBtn.textContent = '✅ Copied!';
          setTimeout(() => {
            copyUrlBtn.textContent = '📋 Copy Link';
          }, 2200);
        } catch (_e) {}
      });
    }

    // Register Offline Service Worker (PWA)
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('./sw.js')
          .then(() => {
            const titleEl = document.getElementById('pwaOfflineTitle');
            if (titleEl) titleEl.textContent = 'Offline Course Cache Active (PWA Ready)';
          })
          .catch(() => {});
      });
    }
  }

  // Boot App
  applyTheme(state.theme);
  syncSimulatorPositionToShot();
  initEvents();
  renderAll();
})();
