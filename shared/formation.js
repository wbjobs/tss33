const FORMATION_TYPES = {
  V_SHAPE: 'v_shape',
  ECHELON: 'echelon',
  CIRCLE: 'circle',
  LINE: 'line',
  DIAMOND: 'diamond'
};

const DEFAULT_FORMATION_CONFIG = {
  spacing: 0.0005,
  altitudeStep: 10,
  baseAltitude: 100
};

function calculateFormation(droneCount, formationType, centerLat, centerLng, centerAlt, config = {}) {
  const cfg = { ...DEFAULT_FORMATION_CONFIG, ...config };
  const positions = [];

  switch (formationType) {
    case FORMATION_TYPES.V_SHAPE:
      positions.push(...calculateVShape(droneCount, centerLat, centerLng, centerAlt, cfg));
      break;
    case FORMATION_TYPES.ECHELON:
      positions.push(...calculateEchelon(droneCount, centerLat, centerLng, centerAlt, cfg));
      break;
    case FORMATION_TYPES.CIRCLE:
      positions.push(...calculateCircle(droneCount, centerLat, centerLng, centerAlt, cfg));
      break;
    case FORMATION_TYPES.LINE:
      positions.push(...calculateLine(droneCount, centerLat, centerLng, centerAlt, cfg));
      break;
    case FORMATION_TYPES.DIAMOND:
      positions.push(...calculateDiamond(droneCount, centerLat, centerLng, centerAlt, cfg));
      break;
    default:
      positions.push(...calculateCircle(droneCount, centerLat, centerLng, centerAlt, cfg));
  }

  return positions;
}

function calculateVShape(count, centerLat, centerLng, centerAlt, cfg) {
  const positions = [];
  const { spacing, altitudeStep } = cfg;

  positions.push({
    lat: centerLat,
    lng: centerLng,
    alt: centerAlt
  });

  for (let i = 1; i < count; i++) {
    const side = i % 2 === 1 ? 1 : -1;
    const row = Math.floor((i + 1) / 2);
    const latOffset = row * spacing;
    const lngOffset = row * spacing * side;
    const altOffset = row * altitudeStep * 0.5;

    positions.push({
      lat: centerLat + latOffset,
      lng: centerLng + lngOffset,
      alt: centerAlt + altOffset
    });
  }

  return positions;
}

function calculateEchelon(count, centerLat, centerLng, centerAlt, cfg) {
  const positions = [];
  const { spacing, altitudeStep } = cfg;
  const halfCount = Math.floor(count / 2);

  for (let i = 0; i < count; i++) {
    const offset = i - halfCount;
    positions.push({
      lat: centerLat + offset * spacing * 0.5,
      lng: centerLng + offset * spacing,
      alt: centerAlt + offset * altitudeStep * 0.3
    });
  }

  return positions;
}

function calculateCircle(count, centerLat, centerLng, centerAlt, cfg) {
  const positions = [];
  const { spacing, altitudeStep } = cfg;
  const radius = Math.max(spacing * 1.5, (count * spacing) / (2 * Math.PI));

  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    const layer = Math.floor(i / 8);
    const layerRadius = radius + layer * spacing;
    const layerAngle = angle + layer * 0.2;

    positions.push({
      lat: centerLat + Math.sin(layerAngle) * layerRadius,
      lng: centerLng + Math.cos(layerAngle) * layerRadius,
      alt: centerAlt + layer * altitudeStep
    });
  }

  return positions;
}

function calculateLine(count, centerLat, centerLng, centerAlt, cfg) {
  const positions = [];
  const { spacing, altitudeStep } = cfg;
  const halfCount = Math.floor(count / 2);

  for (let i = 0; i < count; i++) {
    const offset = i - halfCount;
    positions.push({
      lat: centerLat + offset * spacing,
      lng: centerLng,
      alt: centerAlt + Math.abs(offset) * altitudeStep * 0.2
    });
  }

  return positions;
}

function calculateDiamond(count, centerLat, centerLng, centerAlt, cfg) {
  const positions = [];
  const { spacing, altitudeStep } = cfg;

  const layers = [];
  let remaining = count;
  let layer = 0;

  while (remaining > 0) {
    const layerSize = Math.min(remaining, layer * 2 + 1);
    layers.push(layerSize);
    remaining -= layerSize;
    layer++;
  }

  let droneIndex = 0;
  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layerSize = layers[layerIdx];
    const startOffset = -Math.floor(layerSize / 2);

    for (let i = 0; i < layerSize; i++) {
      const offset = startOffset + i;
      positions.push({
        lat: centerLat + layerIdx * spacing,
        lng: centerLng + offset * spacing,
        alt: centerAlt + layerIdx * altitudeStep * 0.4
      });
      droneIndex++;
    }
  }

  return positions;
}

function getFormationInfo(formationType) {
  const info = {
    [FORMATION_TYPES.V_SHAPE]: {
      name: 'V 字队形',
      description: '经典雁阵，领头机在前，两侧对称排列',
      icon: 'v-shape'
    },
    [FORMATION_TYPES.ECHELON]: {
      name: '梯队',
      description: '斜向排列，便于观察和通信',
      icon: 'echelon'
    },
    [FORMATION_TYPES.CIRCLE]: {
      name: '圆圈',
      description: '环形排列，适合环绕侦察',
      icon: 'circle'
    },
    [FORMATION_TYPES.LINE]: {
      name: '横队',
      description: '一字排开，适合广域搜索',
      icon: 'line'
    },
    [FORMATION_TYPES.DIAMOND]: {
      name: '菱形',
      description: '密集菱形，突防队形',
      icon: 'diamond'
    }
  };

  return info[formationType] || { name: formationType, description: '', icon: '' };
}

export {
  FORMATION_TYPES,
  DEFAULT_FORMATION_CONFIG,
  calculateFormation,
  getFormationInfo
};
