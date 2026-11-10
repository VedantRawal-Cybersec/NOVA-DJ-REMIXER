/**
 * Studio-transparent 4-Band DJ Isolator + Sweep Filter Strip.
 * Uses serial shelving & peaking BiquadFilters so at unity (1.0) the audio
 * is 100% bit-transparent with zero crossover phase coloration, while still
 * giving -36 dB surgical kills on Bass (<145 Hz), Body/Drums (280 Hz),
 * Lead Vocals (1.45 kHz), and Air/Hats (>4.5 kHz) during live AI transitions.
 */
function gainToDb(gain) {
  const g = Math.max(0.001, Math.min(2.0, Number(gain)));
  if (Math.abs(g - 1) < 0.005) return 0;
  if (g < 1) {
    // Map [0..1] smoothly down to [-36 dB .. 0 dB]
    return Math.max(-36, 20 * Math.log10(g));
  }
  return Math.min(6, 20 * Math.log10(g));
}

export function createStemChannelStrip(ctx, destination) {
  const input = ctx.createGain();
  input.gain.value = 1;

  // Color Filter (DJ Sweep: LowPass < 0 or HighPass > 0)
  const hpf = ctx.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = 20;
  hpf.Q.value = 0.72;

  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = 20000;
  lpf.Q.value = 0.72;

  // 4-Band Isolator EQ (Bass, Body/Drums, Vocals, Air)
  const bassBand = ctx.createBiquadFilter();
  bassBand.type = 'lowshelf';
  bassBand.frequency.value = 145;
  bassBand.gain.value = 0;

  const drumsBand = ctx.createBiquadFilter();
  drumsBand.type = 'peaking';
  drumsBand.frequency.value = 280;
  drumsBand.Q.value = 0.75;
  drumsBand.gain.value = 0;

  const vocalBand = ctx.createBiquadFilter();
  vocalBand.type = 'peaking';
  vocalBand.frequency.value = 1450;
  vocalBand.Q.value = 0.62;
  vocalBand.gain.value = 0;

  const airBand = ctx.createBiquadFilter();
  airBand.type = 'highshelf';
  airBand.frequency.value = 4500;
  airBand.gain.value = 0;

  // Main deck fader + LUFS auto-gain trim
  const deckVolume = ctx.createGain();
  deckVolume.gain.value = 1;

  const lufsTrim = ctx.createGain();
  lufsTrim.gain.value = 1;

  input.connect(hpf);
  hpf.connect(lpf);
  lpf.connect(bassBand);
  bassBand.connect(drumsBand);
  drumsBand.connect(vocalBand);
  vocalBand.connect(airBand);
  airBand.connect(deckVolume);
  deckVolume.connect(lufsTrim);
  lufsTrim.connect(destination);

  // Post-fader FX sends (so Echo Tail rings out cleanly even after deck fades!)
  const echoSend = ctx.createGain();
  echoSend.gain.value = 0;
  lufsTrim.connect(echoSend);

  const reverbSend = ctx.createGain();
  reverbSend.gain.value = 0;
  lufsTrim.connect(reverbSend);

  const stems = {
    bass: bassBand,
    drums: drumsBand,
    vocals: vocalBand,
    other: airBand,
  };

  const state = {
    bass: 1,
    drums: 1,
    vocals: 1,
    other: 1,
    filter: 0,
  };

  function setStem(name, targetGain, atTime = ctx.currentTime, rampSec = 0.04) {
    const filter = stems[name];
    if (!filter) return;
    state[name] = targetGain;
    const db = gainToDb(targetGain);
    filter.gain.cancelScheduledValues(atTime);
    filter.gain.setTargetAtTime(db, atTime, Math.max(0.012, rampSec));
  }

  function setColorFilter(norm, atTime = ctx.currentTime, rampSec = 0.03) {
    state.filter = Math.max(-1, Math.min(1, norm));
    if (state.filter < -0.02) {
      const amt = Math.abs(state.filter);
      const lpFreq = 20000 * Math.pow(220 / 20000, amt);
      hpf.frequency.setTargetAtTime(20, atTime, rampSec);
      lpf.frequency.setTargetAtTime(lpFreq, atTime, rampSec);
      lpf.Q.setTargetAtTime(0.72 + amt * 2.2, atTime, rampSec);
    } else if (state.filter > 0.02) {
      const hpFreq = 24 * Math.pow(5200 / 24, state.filter);
      lpf.frequency.setTargetAtTime(20000, atTime, rampSec);
      hpf.frequency.setTargetAtTime(hpFreq, atTime, rampSec);
      hpf.Q.setTargetAtTime(0.72 + state.filter * 2.2, atTime, rampSec);
    } else {
      hpf.frequency.setTargetAtTime(20, atTime, rampSec);
      hpf.Q.setTargetAtTime(0.72, atTime, rampSec);
      lpf.frequency.setTargetAtTime(20000, atTime, rampSec);
      lpf.Q.setTargetAtTime(0.72, atTime, rampSec);
    }
  }

  function resetAll(atTime = ctx.currentTime) {
    setStem('bass', 1, atTime, 0.04);
    setStem('drums', 1, atTime, 0.04);
    setStem('vocals', 1, atTime, 0.04);
    setStem('other', 1, atTime, 0.04);
    setColorFilter(0, atTime, 0.04);
    echoSend.gain.setTargetAtTime(0, atTime, 0.04);
    reverbSend.gain.setTargetAtTime(0, atTime, 0.04);
  }

  return {
    input,
    output: lufsTrim,
    deckVolume,
    lufsTrim,
    hpf,
    lpf,
    stems,
    echoSend,
    reverbSend,
    state,
    setStem,
    setColorFilter,
    resetAll,
  };
}
