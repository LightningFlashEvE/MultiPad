/********************************************************************************
* @author: iLx1
* @email: colorful_ilx1@163.com
* @date: 2023/11/30 8:25
* @version: 1.0
* @description: 
********************************************************************************/


#include "encoder_user.h"
#include "encoder1.h"
#include "encoder2.h"
#include "encoder3.h"
#include "oled_user.h"
#include "oled_42.h"
#include "lcd_user.h"
#include "screen_readback.h"
#include "pet_mode.h"

static struct menu_sign menu_state = {.pre_menu = UINT8_MAX};
static p_menu_sign_t const menu_sign_p = &menu_state;
static void keyboard_menu_change(void);

/********************************************************************************
* 编码器初始化
********************************************************************************/
void encoder_init_user(void) {
    encoder1_init();
    encoder2_init();
    encoder3_init();
}

void encoder_scan_user(void) {
    encoder1_scan();
    encoder2_scan();
    encoder3_scan();
    if (!pet_mode_is_active() && menu_sign_p->change_flag && HAL_GetTick() - menu_sign_p->changed_at >= 300) {
        menu_sign_p->change_flag = 0;
        keyboard_menu_change();
    }
}

/********************************************************************************
* 菜单锁配置
********************************************************************************/
void set_menu_lock(uint8_t lock_value) {
    menu_sign_p->menu_change_lock = lock_value;
}

/********************************************************************************
* 菜单索引配置
********************************************************************************/
void set_menu_index(uint8_t index_value) {
    menu_sign_p->menu_index = index_value;
}

/********************************************************************************
* 获取菜单索引
********************************************************************************/
uint8_t get_menu_index(void) {
    return menu_sign_p->menu_index;
}

/********************************************************************************
* 防抖函数
********************************************************************************/
void debounce_func() {
    if (!pet_mode_is_active() && menu_sign_p->menu_change_lock == 0) {
        menu_sign_p->changed_at = HAL_GetTick();
        menu_sign_p->change_flag = 1;
        // 显示数字
        oled_42_show_num(menu_sign_p->menu_index, 1, 0);
    }
}

/********************************************************************************
* 菜单层级实质切换
********************************************************************************/
static void keyboard_menu_change(void) {
//    printf("menu_index -> %d\r", menu_index);
    if(menu_sign_p->pre_menu != menu_sign_p->menu_index) {
        menu_sign_p->pre_menu = menu_sign_p->menu_index;
        // 显示菜单
        load_menu(menu_sign_p->menu_index + 1);
    }
}

/********************************************************************************
 *  每个编码器回调函数携带事件参数
 *  0 -> 按下
 *  1 -> 抬起
 *  2 -> 左旋
 *  3 -> 右旋
 *  4 -> 按下左旋
 *  5 -> 按下右旋
********************************************************************************/
static bool handle_small_pet_encoder(uint8_t event, uint8_t button, bool *pet_pressed) {
    const bool active = pet_mode_is_active();
    const bool right = button == 9;
    if (event == ENCODER_DOWN || event == ENCODER_UP) {
        button_readback_record(button, event == ENCODER_DOWN);
        if (event == ENCODER_DOWN) *pet_pressed = active;
        const bool claimed = *pet_pressed;
        if (event == ENCODER_UP) *pet_pressed = false;
        return claimed;
    }
    if (event == DOWN_ANTICLOCKWISE || event == UP_CLOCKWISE) {
        if (right && active && *pet_pressed) pet_mode_cycle_background(event == UP_CLOCKWISE ? 1 : -1);
        return active || *pet_pressed;
    }
    if (active && (event == ANTICLOCKWISE || event == CLOCKWISE)) {
        // The left encoder's physical direction is reversed for the pet clock.
        const bool forward = right ? event == CLOCKWISE : event == ANTICLOCKWISE;
        pet_mode_adjust_scene(forward ? 1 : -1, right);
        return true;
    }
    return *pet_pressed;
}

// 编码器 1
void encoder1_callback(uint8_t encoder_value) {
    static bool pet_pressed;
    if (handle_small_pet_encoder(encoder_value, 8, &pet_pressed)) return;
    if (encoder_value == DOWN_ANTICLOCKWISE) {
        menu_sign_p->menu_index = menu_sign_p->menu_index == 0 ? 9 : menu_sign_p->menu_index - 1;
        debounce_func();
        return;
    }
    if (encoder_value == UP_CLOCKWISE) {
        menu_sign_p->menu_index = menu_sign_p->menu_index == 9 ? 0 : menu_sign_p->menu_index + 1;
        debounce_func();
        return;
    }
    parse_json_value(encoder_value + 16);
}

// 编码器 2
void encoder2_callback(uint8_t encoder_value) {
    static bool pet_pressed;
    if (handle_small_pet_encoder(encoder_value, 9, &pet_pressed)) return;
    parse_json_value(ENCODER_EVENT_NUM + encoder_value + 16);
}

// 编码器 3
void encoder3_callback(uint8_t encoder_value) {
    if (encoder_value == ENCODER_DOWN || encoder_value == ENCODER_UP) {
        button_readback_record(10, encoder_value == ENCODER_DOWN);
        if (pet_mode_encoder_button(encoder_value == ENCODER_DOWN)) return;
    } else if (pet_mode_encoder_rotated(encoder_value == CLOCKWISE || encoder_value == UP_CLOCKWISE,
                                        encoder_value == DOWN_ANTICLOCKWISE || encoder_value == UP_CLOCKWISE)) {
        return;
    }
//    printf("encoder_value -> %d\n\r", (ENCODER_EVENT_NUM * 2) + encoder_value + 16);
    parse_json_value( (ENCODER_EVENT_NUM * 2) + encoder_value + 16);
}
