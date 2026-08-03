function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function findMatchingAuthUser(users, currentUserId, email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;

    return (users || []).find((user) => {
        const candidateEmail = normalizeEmail(user?.email);
        return candidateEmail && candidateEmail === normalizedEmail && user?.id !== currentUserId;
    }) || null;
}

module.exports = {
    normalizeEmail,
    findMatchingAuthUser
};
