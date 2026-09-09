/** The public release repository is fixed in the application, never supplied by a Web page. */
export const SHELL_RELEASE_SOURCE = Object.freeze({
  provider: 'github',
  owner: 'Coyami-MengLuo',
  repo: 'mengluo-dsh-desktop',
  private: false,
})

export const SHELL_RELEASES_URL = `https://github.com/${SHELL_RELEASE_SOURCE.owner}/${SHELL_RELEASE_SOURCE.repo}/releases`
export const PRODUCT_NAME = 'MengLuo DSH Desktop'
