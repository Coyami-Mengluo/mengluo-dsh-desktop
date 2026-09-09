import assert from 'node:assert/strict'

/** Observe the actual renderer animation while the real controller receives frequent progress messages. */
export async function assertProgressMotion(contents, selector, publish) {
  const evaluate = source => contents.executeJavaScript(source)
  contents.debugger.attach('1.3')
  const media = value => contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }],
  })
  let interval
  try {
    await media('no-preference')
    interval = setInterval(publish, 16)
    const sample = await evaluate(`new Promise(resolve => {
      const meter = document.querySelector(${JSON.stringify(selector)});
      const sweep = meter.querySelector('.progress-sweep');
      const positions = new Set();
      const animations = new Set();
      let frames = 0, previousTime = -1, resets = 0;
      const frame = () => {
        const animation = sweep.getAnimations()[0];
        if (animation && animation.currentTime !== null) {
          animations.add(animation);
          if (animation.currentTime < previousTime) resets++;
          previousTime = animation.currentTime;
          positions.add(getComputedStyle(sweep).transform);
        }
        if (++frames < 48) requestAnimationFrame(frame);
        else resolve({ positions: positions.size, animations: animations.size, resets, value: meter.getAttribute('aria-valuenow') });
      };
      requestAnimationFrame(frame);
    })`)
    assert.ok(sample.positions >= 40, `progress motion skipped too many frames: ${JSON.stringify(sample)}`)
    assert.equal(sample.animations, 1, 'activity must not replace the running animation')
    assert.equal(sample.resets, 0, 'activity must not rewind the running animation')
    assert.equal(sample.value, null, 'unknown totals must not claim numeric progress')
    await media('reduce')
    assert.equal(await evaluate(`new Promise(resolve => requestAnimationFrame(() => {
      const meter = document.querySelector(${JSON.stringify(selector)});
      resolve(meter.querySelector('.progress-sweep').getAnimations().length === 0
        && getComputedStyle(meter.querySelector('.progress-fill')).transitionDuration === '0s');
    }))`), true)
  } finally {
    clearInterval(interval)
    contents.debugger.detach()
  }
}
