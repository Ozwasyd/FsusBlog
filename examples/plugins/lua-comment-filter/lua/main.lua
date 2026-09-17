function activate(ctx)
  ctx.hooks:on("comment.beforeCreate", function(event)
    if string.find(event.content, "spam", 1, true) then
      return ctx.comment.reject("spam_detected")
    end

    return ctx.next()
  end)
end
