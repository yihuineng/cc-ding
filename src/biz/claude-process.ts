  const messageWithPrefix = senderNick && senderStaffId
    ? `${message} ── 消息来自: ${senderNick}(${senderStaffId})`
    : message;