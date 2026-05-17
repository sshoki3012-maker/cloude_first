import random


HANDS = ("グー", "チョキ", "パー")
WIN_MAP = {"グー": "チョキ", "チョキ": "パー", "パー": "グー"}


def get_player_hand():
    while True:
        print("\n手を選んでください:")
        for i, hand in enumerate(HANDS):
            print(f"  {i}: {hand}")
        print("  q: 終了")
        choice = input("> ").strip()
        if choice.lower() == "q":
            return None
        if choice.isdigit() and 0 <= int(choice) < len(HANDS):
            return HANDS[int(choice)]
        print("無効な入力です。もう一度お試しください。")


def judge(player, cpu):
    if player == cpu:
        return "draw"
    if WIN_MAP[player] == cpu:
        return "win"
    return "lose"


def main():
    wins = losses = draws = 0
    print("=== じゃんけんゲーム ===")
    while True:
        player = get_player_hand()
        if player is None:
            break
        cpu = random.choice(HANDS)
        print(f"\nあなた: {player}  /  CPU: {cpu}")
        result = judge(player, cpu)
        if result == "win":
            wins += 1
            print("あなたの勝ち!")
        elif result == "lose":
            losses += 1
            print("あなたの負け...")
        else:
            draws += 1
            print("あいこ")
        print(f"成績 -> 勝ち: {wins}  負け: {losses}  あいこ: {draws}")
    print("\nゲーム終了。お疲れさまでした!")


if __name__ == "__main__":
    main()
