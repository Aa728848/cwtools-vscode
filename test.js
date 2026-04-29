const text = `
tech_space_exploration = {
    cost = 0
    area = physics
    tier = 0
    category = { computing }
    prerequisites = { "tech_basic_science_lab_1" }
    weight = 0
}
`;
const prereqMatch = text.match(/\bprerequisites\s*=\s*\{([^}]*)\}/s);
console.log("prereqMatch:", prereqMatch ? prereqMatch[1] : "null");
if (prereqMatch) {
    const ids = prereqMatch[1].trim().split(/[\s\n\r\t]+/).map(s => s.replace(/^"|"$/g, '')).filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));
    console.log("ids:", ids);
}
