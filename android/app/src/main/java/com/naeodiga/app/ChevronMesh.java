package com.naeodiga.app;

import java.util.ArrayList;
import java.util.List;

/**
 * 입체 쉐브론(V자 화살표) 메시. +Z를 가리키고 y=0 바닥에 놓이며 높이 H만큼 솟는다.
 * 정점마다 위치 3 + 법선 3 (삼각형 목록, 컬링 끔). 윗면은 파랑, 옆면은 흰색으로 셰이더가 법선으로 구분한다.
 */
final class ChevronMesh {
    static final float W = .42f, L = .55f, T = .17f, H = .09f;  // 반폭, 길이, 띠 두께, 높이 (m)

    static float[] build() {
        // 위에서 본 외곽 (x, z): A B C C' B' A'
        float[][] o = {{-W, 0}, {0, L}, {W, 0}, {W, -T}, {0, L - T}, {-W, -T}};
        float area = 0;  // 부호 있는 넓이: 감는 방향에 따라 바깥쪽 법선 방향이 정해진다 (오목해서 중심점 비교는 안 됨)
        for (int i = 0; i < 6; i++) area += o[i][0] * o[(i + 1) % 6][1] - o[(i + 1) % 6][0] * o[i][1];
        float sign = area > 0 ? 1 : -1;
        List<float[]> v = new ArrayList<>();
        int[][] tris = {{0, 1, 4}, {0, 4, 5}, {1, 2, 3}, {1, 3, 4}};  // 두 팔 (사각형 둘)
        for (int[] t : tris) for (int k : t) v.add(new float[]{o[k][0], H, o[k][1], 0, 1, 0});
        for (int i = 0; i < 6; i++) {
            float[] a = o[i], b = o[(i + 1) % 6];
            float ex = b[0] - a[0], ez = b[1] - a[1], len = (float)Math.hypot(ex, ez);
            float nx = sign * ez / len, nz = -sign * ex / len;  // 바깥쪽
            float[][] q = {{a[0], 0, a[1]}, {b[0], 0, b[1]}, {b[0], H, b[1]}, {a[0], H, a[1]}};
            for (int k : new int[]{0, 1, 2, 0, 2, 3}) v.add(new float[]{q[k][0], q[k][1], q[k][2], nx, 0, nz});
        }
        float[] out = new float[v.size() * 6];
        for (int i = 0; i < v.size(); i++) System.arraycopy(v.get(i), 0, out, i * 6, 6);
        return out;
    }
}
