"""Prompt templates for each graph node.

Each builder method constructs (system_prompt, user_prompt) tuples for a
specific node's LLM call.  Prompts are grounded in the design space v3
(12 一级意图 × 56 二级意图,A/B 类型 + 知识卡) and never hard-code director
personas or style cards.

ADR-0010 三层推理链(纯推理生成的脊柱):
    B 类效果意图(要观众感到什么)
      → 心理/知觉机制(为什么会感到)
      → A 类构成意图(画面上怎么安排)
      → 十参数(具体取值,rationale 引用意图 code)

设计空间文本(digest)由 ontology 模块生成,prompt 只负责消费。
"""

from __future__ import annotations

from typing import Any


# 输出语言规则:面向用户的展示文本用英文,镜头语言受控字段 + 即梦指令保持中文。
# 拼到每个节点 system 末尾,让前端展示全英文、而后端解析/即梦接口仍吃中文。
_LANG_RULE = (
    "\n\n【输出语言规则(务必遵守)】面向用户展示的文本一律用**英文**书写,包括:"
    "reflection(复述)、widget 的提问与选项 label/ends、方向 name 与 mechanism、"
    "strategy、rationale、overall_rationale、brief、审校 issues 与 suggestions。"
    "但以下内容必须保持**中文**不变:九个镜头语言受控字段"
    "(shot_size、composition、angle、movement、focal_length、depth_of_field、"
    "lighting、color_tone、rhythm)的取值,以及 frame_edit_hint(发给图像生成模型的重摄指令)。"
    "意图 code(如 3.4)与 dim(一级意图名)原样保留、不要翻译。"
)


class PromptBuilder:
    """Constructs structured prompts for each pipeline node."""

    @staticmethod
    def _image_section(image_brief: str | None) -> str:
        """Shared prompt section for the user-uploaded base image (重拍摄语义)."""
        if not image_brief:
            return ""
        return (
            "\n\n## 基底画面解析(本次任务 = 为这张画面设计重拍摄方案)\n"
            f"{image_brief}\n"
            "约定:画面只锚定【主体与空间】(谁、在什么环境里),不可凭空更换;"
            "拍摄风格——光线/色调/机位/景别/节奏/氛围——完全服从用户意图,"
            "允许与原画面气质截然不同(如喜剧感画面改作恐怖片拍法)。"
            "画面现有的光线氛围只是现状,不代表用户想要的方向。"
        )

    @staticmethod
    def align_intent(
        design_space: str,
        current_intent: dict[str, Any],
        user_input: str,
        image_brief: str | None = None,
    ) -> tuple[str, str]:
        """Align agent prompt.

        System: Intent alignment specialist role description.
        User: design space digest + current intent state + user input.
        Expected output JSON: reflection, dimension_updates, widgets, ready_to_generate
        """
        system = (
            "你是创作意图对齐者。把用户模糊的表达映射到「导演意图设计空间」"
            "(12 个一级意图 × 56 个二级意图),用最少的提问帮其澄清。\n\n"
            "意图分两类,提问方式不同:\n"
            "- B 类(效果意图:情绪唤起/氛围营造/共情建立/好奇悬念惊讶):"
            "问『想让观众产生什么感受』。\n"
            "- A 类(构成意图:注意/视点/人物/节奏/信息给予/情境/空间/构图/表意):"
            "问『想在画面上怎么安排』。\n"
            "用户通常先说出 B 类效果;A 类手段若用户没有明确偏好,留给生成阶段推理,不要逼问。\n\n"
            "如何推理决定问什么:\n"
            "- 通读已知信息,判断:对「这一个具体意图」而言,哪些维度既对最终镜头语言影响重大、"
            "又仍不明确——优先就这些发问。\n"
            "- 用户表达落入易混淆区(见设计空间末尾判别规则)时,直接用对应 probe 发问判别。\n"
            "- 命中带『取值』标注的二级意图(如 5.1-5.4)时,需追问具体取值。\n"
            "- 命中双极轴(节奏快慢/空间尺度/构图稳定张力)时,用 slider 控件。\n"
            "- 每轮最多 3 个控件。\n\n"
            "维度状态用定性标签:open / leaning / resolved / conflicting / blocked_by:X,"
            "由你推理得出,不要打数值分。\n\n"
            "输出 JSON:\n"
            "{\n"
            '  "reflection": "一句可被否定的复述",\n'
            '  "dimension_updates": {"一级意图名": '
            '{"value": "...", "candidates": ["二级code"], "status": "..."}},\n'
            '  "widgets": [...],\n'
            '  "ready_to_generate": false\n'
            "}\n\n"
            "widget 协议(kind 只能取这四种,字段名严格一致):\n"
            '- 单选 {"kind": "single", "dim": "一级意图名", "prompt": "问题", '
            '"options": [{"value": "二级code", "label": "人话标签", "hint": "可选说明"}]}\n'
            '- 多选 {"kind": "multi", 其余同 single}\n'
            '- 滑块 {"kind": "slider", "dim": "一级意图名", "prompt": "问题", '
            '"ends": ["左极标签", "右极标签"], "ticks": ["6.1", "6.2"]}\n'
            '- 自由文本 {"kind": "freetext", "prompt": "问题", "suggestions": ["建议1"]}\n'
            'option 的 value 必须是二级意图 code(如 "8.3")。'
        )
        system = system + _LANG_RULE
        user = (
            f"## 设计空间(12 一级 × 56 二级)\n{design_space}\n\n"
            f"## 当前 Intent State\n{current_intent}\n\n"
            f"## 用户最新输入\n{user_input}"
            f"{PromptBuilder._image_section(image_brief)}"
        )
        if image_brief:
            user += (
                "\n\n注:画面的主体与空间可作为维度推断的证据(如空间表征/人物塑造),"
                "但画面现有的氛围/光线只是现状——情绪/氛围类维度以用户表达为准,"
                "用户没说就要问,不要从画面现状脑补。"
            )
        return system, user

    @staticmethod
    def check_convergence(
        design_space: str,
        intent_state: dict[str, Any],
        dialogue_history: list[dict],
        image_brief: str | None = None,
    ) -> tuple[str, str]:
        """Convergence checker prompt.

        Judges whether alignment can converge and proceed to generation.
        """
        system = (
            "你在判断'对齐能否收敛、进入生成'。\n\n"
            "1. 维护'要紧维度集':哪些一级意图维度对【这个意图】要紧?各给一句理由。\n"
            "   判要紧用反事实:'该维度换一个二级意图,会不会改变方向级镜头策略?' 不会→不要紧。\n"
            "2. 逐个判要紧维度:resolved / 可接受 leaning / conflicting / blocked_by。\n"
            "   resolved 须能说出下游镜头后果;说不出→要么不要紧、要么没真定。\n"
            "3. 检查易混淆陷阱:选中的二级意图若落在判别规则两侧(如 1.2 与 8.3),"
            "   确认用户表达支持当前一侧;不确定→不收敛,抛判别问题。\n"
            "4. 放行前输出可被否定的复述,待用户确认。\n\n"
            "收敛产物:\n"
            "- tags:选中的二级意图 code 列表(如 [\"3.4\", \"10.2\", \"7.1\"]),"
            "B 类效果与已明确的 A 类手段都收;带取值的意图在 brief 里写明取值。\n"
            "- brief:一段话,综合原始意图 + 各维度结论,是生成阶段的唯一意图陈述。\n\n"
            "输出 JSON:\n"
            "{\n"
            '  "key_dimensions": {"一级意图名": {"reason": "..."}},\n'
            '  "per_dim_judgment": {"一级意图名": {"status": "...", "consequence": "..."}},\n'
            '  "converge": false,\n'
            '  "defer_to_stage2": [],\n'
            '  "reflection": "...",\n'
            '  "brief": "...",\n'
            '  "tags": ["二级code"]\n'
            "}"
        )
        system = system + _LANG_RULE
        user = (
            f"## 设计空间(12 一级 × 56 二级)\n{design_space}\n\n"
            f"## Intent State(含 key_dimensions)\n{intent_state}\n\n"
            f"## 对话历史\n{dialogue_history}"
            f"{PromptBuilder._image_section(image_brief)}"
        )
        return system, user

    @staticmethod
    def strategy_directions(
        intent_state: dict[str, Any],
        knowledge: str,
        constraints: str,
        exemplars: list[dict] | None = None,
        image_brief: str | None = None,
    ) -> tuple[str, str]:
        """Strategy enumeration prompt (ADR-0010: 设计空间直推,非范例归纳).

        Enumerates up to 3 genuinely different mechanism paths for the
        converged intent set.  Optional exemplars are enrichment only.
        """
        system = (
            "你是镜头设计师。对已收敛的意图组合,在设计空间内枚举至多 3 个真正不同的电影化方向。\n\n"
            "什么叫'真正不同':主导机制族不同——同一个效果意图,可以经由不同的构成路径达成。\n"
            "例如『孤独』:(a) 空间表征路径——渺小/被吞没主导,大景别负空间;"
            "(b) 视点/共情路径——主观代入+亲密拉近主导,浅焦特写;"
            "(c) 氛围/节奏路径——疏离氛围+放缓凝滞主导,长镜静观。\n"
            "景别/色调的表面变化不算不同方向;机制不同才算。\n\n"
            "推理链(每个方向都要走完):\n"
            "B 类效果意图 → 该效果的心理/知觉机制(用知识卡) → "
            "主导的 A 类构成意图 → 核心手法概述。\n\n"
            "方向数量取决于意图组合实际支持几条机制路径,不硬凑 3 个;"
            "意图本身已高度指定手段时,1-2 个方向即可。\n"
            "若附有库内范例,可作参考佐证,但方向必须独立于范例成立。\n\n"
            "输出 JSON:\n"
            "{\n"
            '  "directions": [\n'
            "    {\n"
            '      "id": "A",\n'
            '      "name": "方向名(机制路径命名,如 空间吞没路径)",\n'
            '      "dominant_intents": ["主导二级意图code"],\n'
            '      "mechanism": "该方向依赖的心理/知觉机制(一两句)",\n'
            '      "core_technique": "核心手法概述"\n'
            "    }\n"
            "  ]\n"
            "}"
        )
        system = system + _LANG_RULE
        user = (
            f"## Intent State(含 brief 与 tags)\n{intent_state}\n\n"
            f"## 选中意图的知识卡(机制 + 候选手法)\n{knowledge}\n\n"
            f"## 约束(易混淆 / 双极轴)\n{constraints}"
            f"{PromptBuilder._image_section(image_brief)}"
        )
        if image_brief:
            user += (
                "\n\n注:所有方向都是对该基底画面的重拍摄——主体与空间不可凭空更换;"
                "机位/光线/色调/节奏完全服从意图,允许与原画面气质截然不同。"
            )
        if exemplars:
            user += f"\n\n## 库内范例(增强参考,可选)\n{exemplars}"
        return system, user

    @staticmethod
    def generate_direction(
        intent_state: dict[str, Any],
        direction: dict[str, Any],
        knowledge: str,
        critic_feedback: str | None = None,
        image_brief: str | None = None,
        active_skill: dict | None = None,
        style_note: str | None = None,
    ) -> tuple[str, str]:
        """Generate one direction's shot script (plan→detail, 纯推理).

        First outputs a shot-sequence skeleton, then fills ten-parameter shots.
        Every shot must declare which sub-intents it serves.
        """
        system = (
            "你是镜头设计师。按给定的机制方向生成完整镜头脚本。\n\n"
            "推理纪律(三层链,不可跳层):\n"
            "效果意图(要观众感到什么) → 机制(为什么会感到,见知识卡) → "
            "构成安排(画面怎么做) → 十参数取值。\n"
            "每一镜的参数选择必须能沿这条链向上回溯;说不出机制的参数选择不要写。\n\n"
            "第一步 · plan:先出镜头序列骨架(每个 beat:意图功能 + 大致景别/运镜),"
            "体现该方向的机制 DNA;注意 scene 作用域的意图(如氛围)须贯穿全部镜头,"
            "sequence 作用域的意图靠镜头间关系实现。\n"
            "第二步 · detail:把每个 beat 填成完整十参数镜头。\n"
            "- serves:本镜服务的二级意图 code 列表(必填,只能用 tags 内的 code)。\n"
            "- rationale:沿机制链解释参数为何服务这些意图。\n"
            "手法从知识卡汲取,但为'这一个精确意图'改写,不要照搬参照影片。\n\n"
            "硬约束 · 时长(必须满足):duration 以秒计(形如 \"5s\")。"
            "① 单个镜头不超过 5 秒;② 全方案所有镜头时长之和不超过 15 秒。"
            "请在 plan 阶段就按此规划镜头数量与各镜时长(例如 3 镜各 5 秒),"
            "detail 阶段不得突破这两条上限。\n\n"
            "铁律:意图忠实 > 手法华丽。知识卡手法与 brief 冲突时,服从 brief。\n\n"
            "输出 JSON:\n"
            "{\n"
            '  "scheme_id": "A",\n'
            '  "strategy": "方向描述",\n'
            '  "dominant_intents": ["二级code"],\n'
            '  "mechanism": "该方向的机制(一两句)",\n'
            '  "shots": [\n'
            "    {\n"
            '      "order": 1,\n'
            '      "shot_size": "...", "composition": "...", "angle": "...",\n'
            '      "movement": "...", "focal_length": "...", "depth_of_field": "...",\n'
            '      "lighting": "...", "color_tone": "...", "rhythm": "...", "duration": "...",\n'
            '      "serves": ["二级code"],\n'
            '      "rationale": "机制链解释",\n'
            '      "frame_edit_hint": "有基底图时必填,否则留空"\n'
            "    }\n"
            "  ],\n"
            '  "overall_rationale": "整体如何沿机制达成效果意图"\n'
            "}\n\n"
            "frame_edit_hint(仅当提供了基底画面时):本镜的【重摄指令】——"
            "以基底图为起点、可被图像编辑模型直接执行的一两句指令,"
            "覆盖机位/景别变化、主体位置、光线色调与氛围改造,如"
            "『拉远至大远景,人物缩至画面右下角,整体压暗转冷蓝灰调,阴影吞没背景』。"
            "保持主体与空间布局可辨认;风格改造幅度服从意图,需要剧变就大胆剧变。"
        )
        system = system + _LANG_RULE
        from app.evolution import skill_prompt_section

        user = (
            f"## Intent State(含 brief 与 tags)\n{intent_state}\n\n"
            f"## 本方向(机制路径)\n{direction}\n\n"
            f"## 相关知识卡\n{knowledge}"
            f"{PromptBuilder._image_section(image_brief)}"
            f"{skill_prompt_section(active_skill)}"
            f"{style_note or ''}"
        )
        if critic_feedback:
            user += (
                "\n\n## 审校修订意见(这是重生成:逐条修复以下问题,其余保持方向不变)\n"
                f"{critic_feedback}"
            )
        return system, user

    @staticmethod
    def critic(
        intent_state: dict[str, Any],
        shot_script: dict[str, Any],
        constraints: str,
        knowledge: str,
        skill_checks: list[str] | None = None,
    ) -> tuple[str, str]:
        """Critic review prompt.

        Layers: parameter coupling (hard rules run before this call) +
        mechanism-chain fidelity + confusable misuse + bipolar-axis consistency.
        """
        system = (
            "你是一致性审校者。逐项检查:\n\n"
            "1. 参数逻辑:方案内若干镜头连贯,色调/光线和谐。三组参数耦合:\n"
            "   - 空间/画面组:景别·焦距·景深·构图·角度\n"
            "   - 时间/运动组:运镜·节奏·时长\n"
            "   - 影调/情绪组:光影·色彩\n\n"
            "2. 机制链忠实(核心):\n"
            "   - 每镜 serves 引用的 code 必须在收敛 tags 内;引用 tags 外的 code 即失败。\n"
            "   - 对照知识卡:参数取值是否真的服务 rationale 声称的机制?"
            "说得出机制但参数不支撑 → intent_fidelity 失败。\n"
            "   - scene 作用域的意图(如氛围)是否贯穿全部镜头而非只在一两镜出现?\n\n"
            "3. 易混淆误用:脚本实际制造的效果落在判别规则哪一侧?"
            "与 tags 声称的一侧不符 → 失败(如 tags 是悬念 8.3,脚本只做了情绪紧绷 1.2)。\n\n"
            "4. 双极轴自洽:同一方案的镜头不得同时服务一条轴的两极,"
            "除非 rationale 明确说明是刻意对比。\n\n"
            "5. 偏好软检查(仅当下方提供,ADR-0017):逐条对照脚本是否体现;"
            "**只能写进 suggestions 提示,绝不能作为 passed=false 的依据**;"
            "与上述任何硬规则(意图忠实/本体/serves/耦合)冲突时忽略该条软检查。\n\n"
            "输出 JSON:\n"
            "{\n"
            '  "passed": true,\n'
            '  "issues": [{"type": "param_coupling"|"intent_fidelity"'
            '|"confusable_misuse"|"axis_conflict",\n'
            '              "shot_order": 1, "field": "...", "message": "..."}],\n'
            '  "suggestions": ["..."]\n'
            "}"
        )
        system = system + _LANG_RULE
        user = (
            f"## Intent State(含 brief 与 tags)\n{intent_state}\n\n"
            f"## Shot Script\n{shot_script}\n\n"
            f"## 约束(易混淆 / 双极轴)\n{constraints}\n\n"
            f"## 相关知识卡(机制对照)\n{knowledge}"
        )
        if skill_checks:
            checks = "\n".join(f"- {c}" for c in skill_checks)
            user += f"\n\n## 偏好软检查(用户已确证偏好,仅提建议,不作为失败依据)\n{checks}"
        return system, user

    @staticmethod
    def discover_questions(
        evidence_digest: dict[str, Any],
        existing_questions: list[dict[str, Any]],
    ) -> tuple[str, str]:
        """Discovery prompt (ADR-0017): propose preference *questions* from a
        session's interaction cues.

        Behaviour only proposes; it never settles. Bilingual rule (CineScape):
        user-facing text (decision / label / mechanism) in English, ten-parameter
        detail values stay in the Chinese controlled vocabulary.
        """
        system = (
            "你是偏好问题发现者。从一次创作会话的交互线索里,提出关于【这个用户】的"
            "**偏好问题**。核心信条:行为**提出**问题;当同一决策在后续会话**复现**并命中"
            "已有问题时,行为为它所倾向的一侧**投一票**,像探针答案一样推进其状态"
            "(observed→tentative→corroborated)。首次提出只创建(observed,不投票);"
            "复现即证据。完整候选常在多个维度上不同,无法干净归因,故首次不断言偏哪边——"
            "但命中已有的窄问题时,本会话确实倾向了某一侧,要如实指出。\n\n"
            "一道偏好问题 q=(c,d,a,b):\n"
            "- c 上下文(scope):**必须**取自本会话的确认 tags(见线索里的 tags)或 global——\n"
            "  intent_leaf 的 scope_id 只能是本会话 tags 里的某个 code(不得凭空另选一个无关叶子,\n"
            "  否则该偏好在未来同类会话里永远召不回);跨场景的一贯风格(如机位静止、色调冷暖)用 global。\n"
            "  也可用 mechanism(机制族名)。\n"
            "- d 决策轴:一个具体的电影化取舍(如 how to handle threat visibility)。\n"
            "- a,b 两个**设计空间内可执行**的备选,各带 label 与 detail(十参数字段→取值)。\n"
            "  可选 detail 字段:shot_size/composition/angle/movement/focal_length/"
            "depth_of_field/lighting/color_tone/rhythm/duration;也可带 intent_codes、"
            "plan{shot_count,sequence_pattern}。\n"
            "- **每个备选尽量带 mechanism**:一句话说明该备选服务什么心理/知觉机制。"
            "它将成为该偏好被确证后 workflow skill 的推理链片段,写给未来的生成器看。\n\n"
            "输出语言(严格):decision、label、mechanism 面向用户展示,一律**英文**;"
            "detail 的字段值保持**中文受控词表**(与镜头脚本一致)。\n\n"
            "纪律:\n"
            "- 只在交互线索**真的暗示了一个二选一取舍**时提问;情境性修补(这个画面"
            "主体太小才拉远)不要提成偏好。\n"
            "- a,b 必须是同一决策轴上的对立面,且都在设计空间内可执行。\n"
            "- 命中已有问题就给 match_question_id,并给 **match_answer**:本会话行为倾向该问题的"
            "哪一侧(\"a\"/\"b\");若本会话对该问题两侧都没明显倾向,给 \"open\"。已被用户 revoked 的"
            "问题不得重新提出。\n"
            "- 不打任何分数/置信度。**新建**问题时不断言偏哪边(match_answer 只在命中时给)。\n\n"
            "输出 JSON:\n"
            "{\n"
            '  "questions": [\n'
            "    {\n"
            '      "match_question_id": null,\n'
            '      "match_answer": "命中时给 a|b|open,新建时省略",\n'
            '      "scope_type": "intent_leaf|mechanism|global",\n'
            '      "scope_id": "6.2 或 机制族名 或 null",\n'
            '      "decision": "one-sentence decision axis (English)",\n'
            '      "alt_a": {"label": "English label", "detail": {"movement": "固定"},'
            ' "mechanism": "optional English", "intent_codes": ["optional"]},\n'
            '      "alt_b": {"label": "English label", "detail": {"movement": "缓慢推进"}}\n'
            "    }\n"
            "  ]\n"
            "}"
        )
        user = (
            f"## 本次会话交互线索(已做确定性预处理)\n{evidence_digest}\n\n"
            f"## 该用户已有的偏好问题(命中则给 match_question_id;revoked 的不得重提)\n"
            f"{existing_questions}"
        )
        return system, user

    @staticmethod
    def edit_revalidate(
        shot_script: dict[str, Any],
        edit_patch: dict[str, Any],
    ) -> tuple[str, str]:
        """Edit collaboration: validate a user edit for consistency."""
        system = (
            "你是编辑协作助手。用户对一个镜头脚本进行了编辑,请检查编辑是否破坏了参数一致性,"
            "以及是否削弱了该镜 serves 声称服务的意图。\n\n"
            "如果编辑合理,返回空 conflicts。\n"
            "如果编辑导致冲突(如把景别改成特写却还留着大量负空间构图),列出冲突。\n\n"
            "输出 JSON:\n"
            "{\n"
            '  "conflicts": [{"shot_order": 1, "field": "...", "message": "..."}],\n'
            '  "suggestions": ["..."]\n'
            "}"
        )
        user = f"## 原脚本\n{shot_script}\n\n## 编辑\n{edit_patch}"
        return system, user
