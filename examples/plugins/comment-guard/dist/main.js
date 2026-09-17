const definePlugin = plugin => plugin

export default definePlugin({
  id: 'fsusblog.plugin.comment-guard',

  async activate(ctx) {
    ctx.hooks.on('comment.beforeCreate', async event => {
      if (event.payload.content.includes('spam')) {
        await event.log.write('comment rejected by comment-guard')
        return event.comment.reject('spam_detected')
      }

      return event.next()
    })
  }
})
